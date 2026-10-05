import { concat, decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, toHex, toRlp } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { L2MessengerPendingCheckpointSchema, L2MessengerPendingReadSchema, type L2MessengerPendingCheckpoint, type L2MessengerPendingProof, type L2MessengerPendingRead } from "@shared/types/safety-score-v9-l2-messenger-pending";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { getCache, setCache } from "../db-cache";
import { fetchEvmBlockHeader, fetchEvmRpcBatch, type EvmBlockHeader, type EvmRpcBatchCall } from "../evm-rpc";
import type { ChainRpcConfig } from "../chain-registry";

const PAGES_PER_ATTEMPT = 8;
const LOGS_PER_PAGE = 2048;
const CHECKPOINT_MAX_BYTES = 128 * 1024;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const WORD = /^0x[0-9a-f]{64}$/;
const HEX = /^0x[0-9a-f]*$/;
const QUANTITY = /^0x[0-9a-f]+$/;
const NONCE_MASK = (1n << 240n) - 1n;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const relayAbi = parseAbi(["function relayMessage(uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes message)"]);
const bridgeAbi = parseAbi([
  "function finalizeBridgeERC20(address localToken,address remoteToken,address from,address to,uint256 amount,bytes extraData)",
  "function finalizeInboundTransfer(address token,address from,address to,uint256 amount,bytes data)",
]);
const events = parseAbi([
  "event SentMessage(address indexed target,address sender,bytes message,uint256 messageNonce,uint256 gasLimit)",
  "event SentMessageExtension1(address indexed sender,uint256 value)",
  "event MessagePassed(uint256 indexed nonce,address indexed sender,address indexed target,uint256 value,uint256 gasLimit,bytes data,bytes32 withdrawalHash)",
  "event ERC20BridgeInitiated(address indexed localToken,address indexed remoteToken,address indexed from,address to,uint256 amount,bytes extraData)",
  "event DepositInitiated(address l1Token,address indexed from,address indexed to,uint256 indexed sequenceNumber,uint256 amount)",
  "event WithdrawalInitiated(address l1Token,address indexed from,address indexed to,uint256 indexed l2ToL1Id,uint256 exitNum,uint256 amount)",
  "event DepositFinalized(address indexed l1Token,address indexed from,address indexed to,uint256 amount)",
  "event MessageDelivered(uint256 indexed messageIndex,bytes32 indexed beforeInboxAcc,address inbox,uint8 kind,address sender,bytes32 messageDataHash,uint256 baseFeeL1,uint64 timestamp)",
  "event InboxMessageDelivered(uint256 indexed messageNum,bytes data)",
  "event L2ToL1Tx(address caller,address indexed destination,uint256 indexed hash,uint256 indexed position,uint256 arbBlockNum,uint256 ethBlockNum,uint256 timestamp,uint256 callvalue,bytes data)",
  "event RedeemScheduled(bytes32 indexed ticketId,bytes32 indexed retryTxHash,uint64 indexed sequenceNum,uint64 donatedGas,address gasDonor,uint256 maxRefund,uint256 submissionFeeRefund)",
]);
const topic = (signature: string) => keccak256(toHex(signature));
const SENT = topic("SentMessage(address,address,bytes,uint256,uint256)");
const PASSED = topic("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)");
const DELIVERED = topic("MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)");
const WITHDRAWAL = topic("L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)");
const REDEEM = topic("RedeemScheduled(bytes32,bytes32,uint64,uint64,address,uint256,uint256)");
type Log = { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}`;
  blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; removed: false };
type Message = L2MessengerPendingCheckpoint["messages"][number];
interface TokenPayload { from: string; to: string; amount: bigint; extra: string }
function fail(reason: string): never { throw new Error(`l2-pending:${reason}`); }
function word(value: unknown): bigint {
  if (typeof value !== "string" || !WORD.test(value)) fail("state-unavailable");
  return BigInt(value);
}
function bool(value: unknown): boolean {
  const n = word(value);
  if (n !== 0n && n !== 1n) fail("state-invalid");
  return n === 1n;
}
function call(to: string, signature: string, args: string = ""): EvmRpcBatchCall {
  return { method: "eth_call", params: [{ to, data: toFunctionSelector(signature) + args }] };
}
function checkedLog(raw: unknown, from: number, to: number): Log {
  if (!raw || typeof raw !== "object") fail("log-invalid");
  const row = raw as Record<string, unknown>;
  if (typeof row.address !== "string" || !/^0x[0-9a-f]{40}$/.test(row.address) ||
    !Array.isArray(row.topics) || row.topics.length === 0 || row.topics.some(t => typeof t !== "string" || !WORD.test(t)) ||
    typeof row.data !== "string" || !HEX.test(row.data) || row.data.length % 2 !== 0 || row.data.length > 16386 ||
    typeof row.blockHash !== "string" || !WORD.test(row.blockHash) ||
    typeof row.transactionHash !== "string" || !WORD.test(row.transactionHash) || row.removed !== false ||
    typeof row.blockNumber !== "string" || !QUANTITY.test(row.blockNumber) ||
    typeof row.logIndex !== "string" || !QUANTITY.test(row.logIndex)) fail("log-invalid");
  const height = Number(BigInt(row.blockNumber as string)), index = Number(BigInt(row.logIndex as string));
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(index) || index >= 1_000_000 || height < from || height > to) fail("log-invalid");
  return row as Log;
}
function decode(log: Log) { return decodeEventLog({ abi: events, data: log.data, topics: log.topics, strict: true }); }
function tokenPayload(source: L2MessengerPendingRead, data: `0x${string}`, deposit: boolean): TokenPayload | null {
  // StandardBridge also carries ETH. It participates in the global nonce
  // census but is not a liability of the reviewed ERC-20 token pair.
  if (source.protocol === "op-stack" && source.bridgeFlavor === "standard" &&
    data.slice(0, 10) === toFunctionSelector("finalizeBridgeETH(address,address,uint256,bytes)")) return null;
  const payload = decodeFunctionData({ abi: bridgeAbi, data });
  if (source.protocol === "op-stack") {
    if (payload.functionName !== "finalizeBridgeERC20") fail("payload-invalid");
    const [local, remote, from, to, amount, extra] = payload.args;
    if (local.toLowerCase() !== (deposit ? source.l2Token : source.l1Token) || remote.toLowerCase() !== (deposit ? source.l1Token : source.l2Token)) return null;
    return { from: from.toLowerCase(), to: to.toLowerCase(), amount, extra };
  }
  if (payload.functionName !== "finalizeInboundTransfer") fail("payload-invalid");
  const [token, from, to, amount] = payload.args;
  if (token.toLowerCase() !== source.l1Token) return null;
  return { from: from.toLowerCase(), to: to.toLowerCase(), amount, extra: "0x" };
}
/** Canonical, inclusive history with state-count census at every page boundary.
 * No indexer or escrow-minus-receipts inference. A first run proves empty initial
 * liabilities, then bootstraps history incrementally; a recent challenge-window
 * scan alone is never an exhaustive initial census. All network work is serial.
 */
export async function observeL2MessengerPending(input: {
  source: L2MessengerPendingRead; headers: readonly EvmBlockHeader[];
  chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; db?: D1Database;
  checkpoint?: L2MessengerPendingCheckpoint;
}): Promise<
  | { status: "accepted"; amount: string; proof: L2MessengerPendingProof; responseSha256: string; checkpoint: L2MessengerPendingCheckpoint }
  | { status: "rejected"; reason: string; checkpoint?: L2MessengerPendingCheckpoint }
> {
  let checkpoint: L2MessengerPendingCheckpoint | undefined;
  try {
    const parsed = L2MessengerPendingReadSchema.safeParse(input.source);
    if (!parsed.success) fail("source-invalid");
    const source = parsed.data;
    const sourceDigest = sha256Hex(stableJsonStringifyV1(source));
    const cacheKey = `safety-score-v9:l2-messenger-pending:v1:${sourceDigest}`;
    const chains = [source.chainId, source.l2ChainId], starts = [source.l1StartBlock, source.l2StartBlock];
    const options = { chainRpcs: input.chainRpcs, signal: input.signal };
    const rpc = async (index: number, calls: EvmRpcBatchCall[]) => {
      throwIfAborted(input.signal);
      const result = await fetchEvmRpcBatch(chains[index]!, calls, options);
      if (!result || result.length !== calls.length) fail("rpc-unavailable");
      return result!;
    };
    const state = (header: EvmBlockHeader) => ({ blockHash: header.hash, requireCanonical: true });
    const read = async (index: number, header: EvmBlockHeader, calls: EvmRpcBatchCall[]) => rpc(index, calls.map(row => ({ ...row, params: [...row.params, state(header)] })));
    if (input.headers.length !== 2) fail("pin-missing");
    for (let i = 0; i < 2; i++) {
      const pin = input.headers[i]!;
      const finalized = await fetchEvmBlockHeader(chains[i]!, "finalized", options);
      const canonical = await fetchEvmBlockHeader(chains[i]!, pin.number, options);
      if (!finalized || finalized.number < pin.number || pin.number < starts[i]! || !canonical || canonical.hash !== pin.hash || canonical.timestamp !== pin.timestamp) fail("pin-not-finalized");
      const contracts = source.contracts.filter(row => row.chainId === chains[i]);
      const identities = source.identityReads.filter(row => row.chainId === chains[i]);
      const result = await read(i, pin, [
        ...contracts.map(row => ({ method: "eth_getCode", params: [row.address] })),
        ...identities.map(row => ({ method: row.method, params: row.method === "eth_call" ? [{ to: row.address, data: row.data }] : [row.address, row.data] })),
      ]);
      if (contracts.some((row, index) => typeof result[index] !== "string" || !HEX.test(result[index] as string) || (result[index] as string).length % 2 !== 0 || result[index] === "0x" || sha256Hex(result[index] as string) !== row.runtimeCodeSha256) ||
        identities.some((row, index) => result[index + contracts.length] !== row.expected)) fail("identity-mismatch");
      const proxySlots = await read(i, pin, contracts.flatMap(row => [
        { method: "eth_getStorageAt", params: [row.address, IMPLEMENTATION_SLOT] },
        { method: "eth_getStorageAt", params: [row.address, BEACON_SLOT] },
      ]));
      for (let j = 0; j < contracts.length; j++) {
        const implementation = proxySlots[j * 2], beacon = proxySlots[j * 2 + 1];
        if (word(beacon) !== 0n) fail("proxy-beacon-unsupported");
        if (word(implementation) === 0n) continue;
        if (typeof implementation !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(implementation) ||
          !contracts.some(row => row.address === `0x${implementation.slice(-40)}`) ||
          !identities.some(row => row.address === contracts[j]!.address && row.method === "eth_getStorageAt" &&
            row.data === IMPLEMENTATION_SLOT && row.expected === implementation)) fail("implementation-unreviewed");
      }
      const bridge = i === 0 ? source.l1Bridge : source.l2Bridge;
      const remoteBridge = i === 0 ? source.l2Bridge : source.l1Bridge;
      const bindings: Array<{ call: EvmRpcBatchCall; address: string }> = [];
      if (source.protocol === "op-stack") {
        const messenger = i === 0 ? source.l1Messenger : source.l2Messenger;
        bindings.push({ call: call(bridge, source.bridgeFlavor === "standard" ? "OTHER_BRIDGE()" : "otherBridge()"), address: remoteBridge },
          { call: call(bridge, source.bridgeFlavor === "standard" ? "MESSENGER()" : "messenger()"), address: messenger });
        if (source.bridgeFlavor === "sky") {
          bindings.push({ call: call(bridge, "l1ToL2Token(address)", source.l1Token.slice(2).padStart(64, "0")), address: source.l2Token });
          if (i === 0) bindings.push({ call: call(bridge, "escrow()"), address: source.escrowAddress });
        } else if (i === 1) {
          bindings.push({ call: call(source.l2Token, "BRIDGE()"), address: source.l2Bridge },
            { call: call(source.l2Token, "REMOTE_TOKEN()"), address: source.l1Token });
        } else if (source.escrowAddress !== source.l1Bridge) fail("escrow-identity-mismatch");
      } else {
        bindings.push({ call: call(bridge, "counterpartGateway()"), address: remoteBridge },
          { call: call(bridge, "calculateL2TokenAddress(address)", source.l1Token.slice(2).padStart(64, "0")), address: source.l2Token });
        if (i === 0) {
          bindings.push({ call: call(bridge, "inbox()"), address: source.inbox },
            { call: call(source.inbox, "bridge()"), address: source.rollupBridge });
          if (source.escrowAddress !== source.l1Bridge) bindings.push({ call: call(bridge, "escrow()"), address: source.escrowAddress });
        }
      }
      const bound = await read(i, pin, bindings.map(row => row.call));
      if (bindings.some((row, index) => bound[index] !== `0x${row.address.slice(2).padStart(64, "0")}`)) fail("bridge-identity-mismatch");
    }
    const counter = async (index: number, header: EvmBlockHeader) => {
      if (source.protocol === "op-stack") {
        const value = word((await read(index, header, [call(index === 0 ? source.l1Messenger : source.messagePasser, "messageNonce()")]))[0]);
        if (value >> 240n !== 1n) fail("nonce-version-unsupported");
        return value & NONCE_MASK;
      }
      if (index === 0) return word((await read(0, header, [call(source.rollupBridge, "delayedMessageCount()")]))[0]);
      const values = await read(1, header, [{ method: "eth_call", params: [{ from: ZERO_ADDRESS, to: source.arbSys, data: toFunctionSelector("sendMerkleTreeState()") }] }]);
      if (typeof values[0] !== "string" || !HEX.test(values[0]) || values[0].length % 2 !== 0) fail("state-unavailable");
      return decodeAbiParameters(parseAbiParameters("uint256,bytes32,bytes32[]"), values[0] as `0x${string}`)[0];
    };
    const cached = input.db ? await getCache(input.db, cacheKey, input.signal) : null;
    const previous: unknown = input.checkpoint ?? (cached ? JSON.parse(cached.value) as unknown : null);
    if (previous !== null) {
      const cp = L2MessengerPendingCheckpointSchema.safeParse(previous);
      if (!cp.success || cp.data.sourceDigest !== sourceDigest || new Set(cp.data.messages.map(row => `${row.direction}:${row.id}`)).size !== cp.data.messages.length) fail("checkpoint-invalid");
      checkpoint = cp.data;
      for (let i = 0; i < 2; i++) {
        const cursor = checkpoint.cursors[i]!;
        if (cursor.nextBlock < starts[i]! || cursor.nextBlock > input.headers[i]!.number + 1 || cursor.anchorHash === null) fail("checkpoint-invalid");
        const anchor = await fetchEvmBlockHeader(chains[i]!, cursor.nextBlock - 1, options);
        if (!anchor || anchor.hash !== cursor.anchorHash || await counter(i, anchor) !== BigInt(cursor.nextNonce)) fail("checkpoint-reorg");
      }
      if (checkpoint.messages.some(row => {
        const i = row.direction === "deposit" ? 0 : 1;
        return row.blockNumber < starts[i]! || row.blockNumber >= checkpoint!.cursors[i].nextBlock ||
          BigInt(row.nonce) >= BigInt(checkpoint!.cursors[i].nextNonce) ||
          (source.protocol === "op-stack" && row.relayHash === null);
      })) fail("checkpoint-invalid");
    } else {
      const cursors: L2MessengerPendingCheckpoint["cursors"] = [
        { nextBlock: starts[0]!, anchorHash: null, nextNonce: "0", digest: sha256Hex("l2-messenger-history-v1") },
        { nextBlock: starts[1]!, anchorHash: null, nextNonce: "0", digest: sha256Hex("l2-messenger-history-v1") },
      ];
      for (let i = 0; i < 2; i++) {
        const anchor = await fetchEvmBlockHeader(chains[i]!, starts[i]! - 1, options);
        if (!anchor) fail("history-unavailable");
        const balance = i === 0 ? call(source.l1Token, "balanceOf(address)", source.escrowAddress.slice(2).padStart(64, "0")) : call(source.l2Token, "totalSupply()");
        if (word((await read(i, anchor, [balance]))[0]) !== 0n) fail("initial-liabilities-not-empty");
        cursors[i]!.anchorHash = anchor.hash; cursors[i]!.nextNonce = String(await counter(i, anchor));
      }
      checkpoint = { schemaVersion: 1, sourceDigest, cursors, messages: [] };
    }
    const cp = checkpoint;
    let pages = 0, relayHistoryIncomplete = false;
    const logs = async (index: number, address: string, topics: unknown[], from: number, to: number) => {
      const result = (await rpc(index, [{ method: "eth_getLogs", params: [{ address, topics, fromBlock: toHex(from), toBlock: toHex(to) }] }]))[0];
      if (!Array.isArray(result) || result.length > LOGS_PER_PAGE) fail("history-unavailable");
      let position = -1;
      return result.map(raw => {
        const log = checkedLog(raw, from, to), current = Number(BigInt(log.blockNumber)) * 1_000_000 + Number(BigInt(log.logIndex));
        if (!Number.isSafeInteger(current) || current <= position || log.address !== address || log.topics[0] !== topics[0]) fail("history-gap");
        position = current; return log;
      });
    };
    const receipt = async (index: number, tx: string, height: number, hash: string) => {
      const result = (await rpc(index, [{ method: "eth_getTransactionReceipt", params: [tx] }]))[0] as Record<string, unknown> | null;
      if (!result || result.transactionHash !== tx || result.blockHash !== hash || result.blockNumber !== toHex(height) || result.status !== "0x1" || !Array.isArray(result.logs) || result.logs.length > LOGS_PER_PAGE) fail("receipt-unproved");
      const canonical = await fetchEvmBlockHeader(chains[index]!, height, options);
      if (!canonical || canonical.hash !== hash) fail("receipt-unproved");
      return (result!.logs as unknown[]).map(raw => checkedLog(raw, height, height));
    };
    const verifyInitiation = (rows: Log[], deposit: boolean, payload: TokenPayload, nonce?: bigint) => {
      const initiationTopic = topic(source.protocol === "op-stack" ? "ERC20BridgeInitiated(address,address,address,address,uint256,bytes)" : deposit ? "DepositInitiated(address,address,address,uint256,uint256)" : "WithdrawalInitiated(address,address,address,uint256,uint256,uint256)");
      const matches = rows.filter(row => row.address === (deposit ? source.l1Bridge : source.l2Bridge) && row.topics[0] === initiationTopic).filter(row => {
        const event = decode(row);
        if (source.protocol === "op-stack") return event.eventName === "ERC20BridgeInitiated" &&
          event.args.localToken.toLowerCase() === (deposit ? source.l1Token : source.l2Token) && event.args.remoteToken.toLowerCase() === (deposit ? source.l2Token : source.l1Token) &&
          event.args.from.toLowerCase() === payload.from && event.args.to.toLowerCase() === payload.to && event.args.amount === payload.amount && event.args.extraData === payload.extra;
        return deposit ? event.eventName === "DepositInitiated" && event.args.sequenceNumber === nonce && event.args.l1Token.toLowerCase() === source.l1Token && event.args.from.toLowerCase() === payload.from && event.args.to.toLowerCase() === payload.to && event.args.amount === payload.amount
          : event.eventName === "WithdrawalInitiated" && event.args.l2ToL1Id === nonce && event.args.l1Token.toLowerCase() === source.l1Token && event.args.from.toLowerCase() === payload.from && event.args.to.toLowerCase() === payload.to && event.args.amount === payload.amount;
      });
      if (matches.length !== 1) fail("initiation-unproved");
    };
    const add = (message: Message) => {
      if (cp.messages.some(row => row.direction === message.direction && row.id === message.id)) fail("message-duplicate");
      if (cp.messages.length >= 256) fail("checkpoint-capacity");
      cp.messages.push(message);
    };
    for (let i = 0; i < 2; i++) {
      const cursor = cp.cursors[i]!;
      // Fair budget: neither stream can starve the other during bootstrap.
      let directionPages = 0;
      while (cursor.nextBlock <= input.headers[i]!.number && directionPages < (source.protocol === "arbitrum" ? 2 : PAGES_PER_ATTEMPT / 2)) {
        const from = cursor.nextBlock, to = Math.min(input.headers[i]!.number, from + source.scanPageBlocks[i]! - 1);
        const end = await fetchEvmBlockHeader(chains[i]!, to, options);
        if (!end) fail("history-unavailable");
        const address = source.protocol === "op-stack" ? (i === 0 ? source.l1Messenger : source.messagePasser) : (i === 0 ? source.rollupBridge : source.arbSys);
        const rows = await logs(i, address, [source.protocol === "op-stack" ? (i === 0 ? SENT : PASSED) : (i === 0 ? DELIVERED : WITHDRAWAL)], from, to);
        for (const log of rows) {
          const event = decode(log), height = Number(BigInt(log.blockNumber));
          let nonce: bigint;
          if (event.eventName === "SentMessage") nonce = event.args.messageNonce;
          else if (event.eventName === "MessagePassed") nonce = event.args.nonce;
          else if (event.eventName === "MessageDelivered") nonce = event.args.messageIndex;
          else if (event.eventName === "L2ToL1Tx") nonce = event.args.position;
          else fail("log-invalid");
          if (source.protocol === "op-stack") {
            if (nonce! >> 240n !== 1n) fail("nonce-version-unsupported");
            nonce! &= NONCE_MASK;
          }
          if (nonce! !== BigInt(cursor.nextNonce)) fail("nonce-missing");
          cursor.nextNonce = String(nonce! + 1n);
          if (source.protocol === "op-stack") {
            if (event.eventName === "SentMessage") {
              if (event.args.sender.toLowerCase() !== source.l1Bridge || event.args.target.toLowerCase() !== source.l2Bridge) continue;
              const payload = tokenPayload(source, event.args.message, true);
              if (!payload) continue;
              const txLogs = await receipt(0, log.transactionHash, height, log.blockHash);
              verifyInitiation(txLogs, true, payload);
              const extension = txLogs.find(row => row.address === source.l1Messenger && BigInt(row.logIndex) === BigInt(log.logIndex) + 1n);
              if (!extension) fail("message-value-missing");
              const ext = decode(extension!);
              if (ext.eventName !== "SentMessageExtension1" || ext.args.sender.toLowerCase() !== source.l1Bridge || ext.args.value !== 0n) fail("message-value-invalid");
              const hash = keccak256(encodeFunctionData({ abi: relayAbi, functionName: "relayMessage", args: [event.args.messageNonce, event.args.sender, event.args.target, ext.args.value, event.args.gasLimit, event.args.message] }));
              add({ direction: "deposit", id: hash, relayHash: hash, nonce: String(nonce), amount: String(payload.amount), from: payload.from, to: payload.to, blockNumber: height, transactionHash: log.transactionHash, redeemNextBlock: 0 });
            } else if (event.eventName === "MessagePassed") {
              if (event.args.sender.toLowerCase() !== source.l2Messenger || event.args.target.toLowerCase() !== source.l1Messenger) continue;
              const relay = decodeFunctionData({ abi: relayAbi, data: event.args.data });
              const [relayNonce, sender, target, value, , message] = relay.args;
              if (relayNonce >> 240n !== 1n) fail("nonce-version-unsupported");
              if (sender.toLowerCase() !== source.l2Bridge || target.toLowerCase() !== source.l1Bridge) continue;
              const payload = tokenPayload(source, message, false);
              if (!payload) continue;
              if (value !== 0n || event.args.value !== 0n) fail("message-value-invalid");
              const hash = keccak256(encodeAbiParameters(parseAbiParameters("uint256,address,address,uint256,uint256,bytes"), [event.args.nonce, event.args.sender, event.args.target, event.args.value, event.args.gasLimit, event.args.data]));
              // Both values are public on-chain withdrawal commitments, not secrets.
              // eslint-disable-next-line security/detect-possible-timing-attacks
              if (hash !== event.args.withdrawalHash) fail("withdrawal-hash-mismatch");
              verifyInitiation(await receipt(1, log.transactionHash, height, log.blockHash), false, payload);
              if (!bool((await read(1, end, [call(source.messagePasser, "sentMessages(bytes32)", hash.slice(2))]))[0])) fail("withdrawal-unproved");
              add({ direction: "withdrawal", id: hash, relayHash: keccak256(event.args.data), nonce: String(nonce), amount: String(payload.amount), from: payload.from, to: payload.to, blockNumber: height, transactionHash: log.transactionHash, redeemNextBlock: 0 });
            } else fail("log-invalid");
          } else if (event.eventName === "MessageDelivered") {
            const alias = toHex((BigInt(source.l1Bridge) + 0x1111000000000000000000000000000000001111n) % (1n << 160n), { size: 20 });
            if (event.args.sender.toLowerCase() !== alias || event.args.kind !== 9 || event.args.inbox.toLowerCase() !== source.inbox) continue;
            const txLogs = await receipt(0, log.transactionHash, height, log.blockHash);
            const deliveries = txLogs.filter(row => row.address === source.inbox && row.topics[0] === topic("InboxMessageDelivered(uint256,bytes)")).map(decode).filter(row => row.eventName === "InboxMessageDelivered" && row.args.messageNum === nonce);
            if (deliveries.length !== 1 || deliveries[0]!.eventName !== "InboxMessageDelivered") fail("inbox-payload-missing");
            const packed = deliveries[0]!.args.data;
            if (keccak256(packed) !== event.args.messageDataHash || packed.length < 578) fail("inbox-payload-invalid");
            const words = Array.from({ length: 9 }, (_, j) => BigInt(`0x${packed.slice(2 + j * 64, 66 + j * 64)}`));
            const addressWord = (j: number) => { if (words[j]! >= 1n << 160n) fail("inbox-payload-invalid"); return toHex(words[j]!, { size: 20 }); };
            const target = addressWord(0), data = `0x${packed.slice(578)}` as `0x${string}`;
            if (BigInt((data.length - 2) / 2) !== words[8]) fail("inbox-payload-invalid");
            if (target !== source.l2Bridge) continue;
            if (words[1] !== 0n) fail("message-value-invalid");
            const payload = tokenPayload(source, data, true);
            if (!payload) continue;
            verifyInitiation(txLogs, true, payload, nonce);
            const number = (n: bigint): `0x${string}` => n === 0n ? "0x" : toHex(n);
            const id = keccak256(concat(["0x69", toRlp([number(BigInt(source.l2EvmChainId)), toHex(nonce!, { size: 32 }), alias, number(event.args.baseFeeL1), number(words[2]!), number(words[7]!), number(words[6]!), target, number(words[1]!), addressWord(5), number(words[3]!), addressWord(4), data])]));
            add({ direction: "deposit", id, relayHash: null, nonce: String(nonce), amount: String(payload.amount), from: payload.from, to: payload.to, blockNumber: height, transactionHash: log.transactionHash, redeemNextBlock: source.l2StartBlock });
          } else if (event.eventName === "L2ToL1Tx") {
            if (event.args.caller.toLowerCase() !== source.l2Bridge || event.args.destination.toLowerCase() !== source.l1Bridge) continue;
            if (event.args.callvalue !== 0n) fail("message-value-invalid");
            const payload = tokenPayload(source, event.args.data, false);
            if (!payload) continue;
            const leaf = keccak256(concat([event.args.caller, event.args.destination, toHex(event.args.arbBlockNum, { size: 32 }), toHex(event.args.ethBlockNum, { size: 32 }), toHex(event.args.timestamp, { size: 32 }), toHex(event.args.callvalue, { size: 32 }), event.args.data]));
            if (BigInt(leaf) !== event.args.hash) fail("withdrawal-hash-mismatch");
            verifyInitiation(await receipt(1, log.transactionHash, height, log.blockHash), false, payload, nonce);
            add({ direction: "withdrawal", id: leaf, relayHash: null, nonce: String(nonce), amount: String(payload.amount), from: payload.from, to: payload.to, blockNumber: height, transactionHash: log.transactionHash, redeemNextBlock: 0 });
          } else fail("log-invalid");
        }
        if (await counter(i, end) !== BigInt(cursor.nextNonce)) fail("nonce-missing");
        const canonical = await fetchEvmBlockHeader(chains[i]!, to, options);
        if (!canonical || canonical.hash !== end.hash) fail("history-reorg");
        cursor.digest = sha256Hex(stableJsonStringifyV1({ previous: cursor.digest, from, to, hash: end.hash, logs: rows }));
        cursor.nextBlock = to + 1; cursor.anchorHash = end.hash; directionPages++; pages++;
      }
    }
    const retained: Message[] = [];
    let depositAmount = 0n, withdrawalAmount = 0n;
    for (const message of cp.messages) {
      let complete = false;
      if (source.protocol === "op-stack") {
        const index = message.direction === "deposit" ? 1 : 0;
        const successful = bool((await read(index, input.headers[index]!, [call(index === 0 ? source.l1Messenger : source.l2Messenger, "successfulMessages(bytes32)", message.relayHash!.slice(2))]))[0]);
        if (message.direction === "withdrawal") {
          const finalized = bool((await read(0, input.headers[0]!, [call(source.portal, "finalizedWithdrawals(bytes32)", message.id.slice(2))]))[0]);
          // Portal execution can succeed while the application relay fails. Such
          // a burn is still a liability; proven status alone never settles it.
          if (successful && !finalized) fail("withdrawal-state-contradiction");
          complete = finalized && successful;
        } else complete = successful;
      } else if (message.direction === "withdrawal") {
        const result = await read(0, input.headers[0]!, source.outboxes.map(address => call(address, "isSpent(uint256)", toHex(BigInt(message.nonce), { size: 32 }).slice(2))));
        complete = result.map(bool).some(value => value);
      } else {
        const creation = (await rpc(1, [{ method: "eth_getTransactionReceipt", params: [message.id] }]))[0] as Record<string, unknown> | null;
        if (creation !== null) {
          if (!creation || typeof creation.blockNumber !== "string" || !QUANTITY.test(creation.blockNumber) || typeof creation.blockHash !== "string" || !WORD.test(creation.blockHash) || creation.transactionHash !== message.id) fail("receipt-unproved");
          const height = Number(BigInt(creation.blockNumber));
          if (height <= input.headers[1]!.number) {
            const header = await fetchEvmBlockHeader(chains[1]!, height, options);
            if (!header || header.hash !== creation.blockHash) fail("receipt-unproved");
            message.redeemNextBlock = Math.max(message.redeemNextBlock, height);
            while (message.redeemNextBlock <= input.headers[1]!.number && pages < PAGES_PER_ATTEMPT) {
              const from = message.redeemNextBlock, to = Math.min(input.headers[1]!.number, from + source.scanPageBlocks[1] - 1);
              const scheduled = await logs(1, source.retryableTx, [REDEEM, message.id], from, to);
              pages++;
              let pendingExecution = false;
              for (const log of scheduled) {
                const event = decode(log);
                if (event.eventName !== "RedeemScheduled" || event.args.ticketId !== message.id) fail("log-invalid");
                const result = (await rpc(1, [{ method: "eth_getTransactionReceipt", params: [event.args.retryTxHash] }]))[0] as Record<string, unknown> | null;
                if (!result || result.transactionHash !== event.args.retryTxHash || typeof result.blockNumber !== "string" || !QUANTITY.test(result.blockNumber) ||
                  (result.status !== "0x0" && result.status !== "0x1")) fail("receipt-unproved");
                const redeemedHeight = Number(BigInt(result.blockNumber));
                if (redeemedHeight > input.headers[1]!.number) { pendingExecution = true; continue; }
                if (typeof result.blockHash !== "string") fail("receipt-unproved");
                const header = await fetchEvmBlockHeader(chains[1]!, redeemedHeight, options);
                if (!header || header.hash !== result.blockHash) fail("receipt-unproved");
                if (result.status === "0x0") continue;
                const redeemed = await receipt(1, event.args.retryTxHash, redeemedHeight, header!.hash);
                const finalizations = redeemed.filter(row => row.address === source.l2Bridge && row.topics[0] === topic("DepositFinalized(address,address,address,uint256)")).map(decode).filter(row => row.eventName === "DepositFinalized" && row.args.l1Token.toLowerCase() === source.l1Token && row.args.from.toLowerCase() === message.from && row.args.to.toLowerCase() === message.to && String(row.args.amount) === message.amount);
                if (finalizations.length !== 1) fail("deposit-relay-unproved");
                complete = true;
              }
              // A scheduled redemption whose execution lies after this pin is
              // rechecked next time, rather than forgotten by advancing past it.
              if (complete) break;
              if (pendingExecution) break;
              message.redeemNextBlock = to + 1;
            }
            if (!complete && message.redeemNextBlock <= input.headers[1]!.number) relayHistoryIncomplete = true;
          }
        }
      }
      if (!complete) {
        retained.push(message);
        if (message.direction === "deposit") depositAmount += BigInt(message.amount); else withdrawalAmount += BigInt(message.amount);
      }
    }
    cp.messages = retained;
    const serialized = stableJsonStringifyV1(cp);
    if (new TextEncoder().encode(serialized).length > CHECKPOINT_MAX_BYTES) fail("checkpoint-capacity");
    for (let i = 0; i < 2; i++) {
      const header = await fetchEvmBlockHeader(chains[i]!, input.headers[i]!.number, options);
      if (!header || header.hash !== input.headers[i]!.hash) fail("pin-reorg");
    }
    if (input.db) await setCache(input.db, cacheKey, serialized, input.signal);
    if (relayHistoryIncomplete || cp.cursors.some((cursor, i) => cursor.nextBlock !== input.headers[i]!.number + 1)) return { status: "rejected", reason: "history-incomplete", checkpoint: cp };
    const proof: L2MessengerPendingProof = { sourceDigest, checkpointDigest: sha256Hex(serialized), depositAmount: String(depositAmount), withdrawalAmount: String(withdrawalAmount),
      pins: chains.map((chainId, i) => ({ chainId, anchor: input.headers[i]!.number, anchorHash: input.headers[i]!.hash, observedAtSec: input.headers[i]!.timestamp, nextNonce: cp.cursors[i]!.nextNonce })) };
    const amount = String(depositAmount + withdrawalAmount);
    return { status: "accepted", amount, proof, responseSha256: sha256Hex(stableJsonStringifyV1({ proof, amount })), checkpoint: cp };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { status: "rejected", reason: error instanceof Error && error.message.startsWith("l2-pending:") ? error.message.slice(11) : "rpc-unavailable" };
  }
}
