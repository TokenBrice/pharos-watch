import { beforeEach, describe, expect, it, vi } from "vitest";
import { concat, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import type { L2MessengerPendingRead } from "@shared/types/safety-score-v9-l2-messenger-pending";
import { L2MessengerPendingReadSchema } from "@shared/types/safety-score-v9-l2-messenger-pending";
import { observeL2MessengerPending } from "../safety-score-v9/l2-messenger-pending-observer";
import { fetchEvmBlockHeader, fetchEvmRpcBatch, type EvmBlockHeader } from "../evm-rpc";
import { ReviewedEconomicSupplyPlanSchema, type EconomicSupplyObservation, type ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import type { BridgeRouteRiskProfile, StablecoinMeta } from "@shared/types/core";
import { deriveReviewedEconomicDeploymentPartition } from "../safety-score-v9/supply-attribution-contract";

vi.mock("../evm-rpc", () => ({ fetchEvmBlockHeader: vi.fn(), fetchEvmRpcBatch: vi.fn() }));
const address = (n: number) => toHex(n, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const version = 1n << 240n;
const code = "0x60006000";
const user = address(80), recipient = address(81);
const bridgeAbi = parseAbi(["function finalizeBridgeERC20(address localToken,address remoteToken,address from,address to,uint256 amount,bytes extraData)", "function finalizeInboundTransfer(address token,address from,address to,uint256 amount,bytes data)"]);
const relayAbi = parseAbi(["function relayMessage(uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes message)"]);
const eventAbi = parseAbi([
  "event SentMessage(address indexed target,address sender,bytes message,uint256 messageNonce,uint256 gasLimit)",
  "event SentMessageExtension1(address indexed sender,uint256 value)",
  "event MessagePassed(uint256 indexed nonce,address indexed sender,address indexed target,uint256 value,uint256 gasLimit,bytes data,bytes32 withdrawalHash)",
  "event ERC20BridgeInitiated(address indexed localToken,address indexed remoteToken,address indexed from,address to,uint256 amount,bytes extraData)",
  "event MessageDelivered(uint256 indexed messageIndex,bytes32 indexed beforeInboxAcc,address inbox,uint8 kind,address sender,bytes32 messageDataHash,uint256 baseFeeL1,uint64 timestamp)",
  "event InboxMessageDelivered(uint256 indexed messageNum,bytes data)",
  "event DepositInitiated(address l1Token,address indexed from,address indexed to,uint256 indexed sequenceNumber,uint256 amount)",
  "event L2ToL1Tx(address caller,address indexed destination,uint256 indexed hash,uint256 indexed position,uint256 arbBlockNum,uint256 ethBlockNum,uint256 timestamp,uint256 callvalue,bytes data)",
  "event WithdrawalInitiated(address l1Token,address indexed from,address indexed to,uint256 indexed l2ToL1Id,uint256 exitNum,uint256 amount)",
  "event RedeemScheduled(bytes32 indexed ticketId,bytes32 indexed retryTxHash,uint64 indexed sequenceNum,uint64 donatedGas,address gasDonor,uint256 maxRefund,uint256 submissionFeeRefund)",
  "event DepositFinalized(address indexed l1Token,address indexed from,address indexed to,uint256 amount)",
]);
type TestLog = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; removed: boolean };
type FixtureSource = L2MessengerPendingRead & {
  l1Token: `0x${string}`; l2Token: `0x${string}`; l1Bridge: `0x${string}`; l2Bridge: `0x${string}`;
  l1Messenger?: `0x${string}`; l2Messenger?: `0x${string}`;
};
let source: FixtureSource;
let logs: Record<string, TestLog[]>;
let receipts: Record<string, unknown>;
let storage: Record<string, string>;
let finalized: boolean, delivered: boolean, withdrawalRelayed: boolean, missing: boolean, finalityHeight: number, pinHeight: number, initialBalance: bigint;
function header(chain: string, n: number): EvmBlockHeader { return { number: n, hash: hash(n + (chain === "ethereum" ? 1000 : 2000)), timestamp: 100000 + n * 12 }; }
function eventLog(chain: string, contract: string, eventName: string, indexed: Record<string, unknown>, parameters: string, values: unknown[], index: number, height = 1): TestLog {
  const topics = encodeEventTopics({ abi: eventAbi, eventName, args: indexed } as never) as string[];
  return { address: contract, topics, data: encodeAbiParameters(parseAbiParameters(parameters), values as never), blockNumber: toHex(height), blockHash: header(chain, height).hash, transactionHash: hash((chain === "ethereum" ? 3000 : 4000) + height), logIndex: toHex(index), removed: false };
}
function store(chain: string, rows: TestLog[]) {
  logs[chain]!.push(...rows);
  const first = rows[0]!;
  receipts[first.transactionHash] = { transactionHash: first.transactionHash, blockHash: first.blockHash, blockNumber: first.blockNumber, status: "0x1", logs: rows };
}
function opTransfer(deposit: boolean, amount: bigint, height = 1, nonce = 0n) {
  if (source.protocol !== "op-stack") throw new Error("fixture");
  const chain = deposit ? source.chainId : source.l2ChainId;
  const message = encodeFunctionData({ abi: bridgeAbi, functionName: "finalizeBridgeERC20", args: [deposit ? source.l2Token : source.l1Token, deposit ? source.l1Token : source.l2Token, user, recipient, amount, "0x"] });
  const bridge = deposit ? source.l1Bridge : source.l2Bridge;
  const init = eventLog(chain, bridge, "ERC20BridgeInitiated", { localToken: deposit ? source.l1Token : source.l2Token, remoteToken: deposit ? source.l2Token : source.l1Token, from: user }, "address,uint256,bytes", [recipient, amount, "0x"], 2, height);
  if (deposit) {
    const sent = eventLog(chain, source.l1Messenger, "SentMessage", { target: source.l2Bridge }, "address,bytes,uint256,uint256", [source.l1Bridge, message, version + nonce, 200000n], 0, height);
    const extension = eventLog(chain, source.l1Messenger, "SentMessageExtension1", { sender: source.l1Bridge }, "uint256", [0n], 1, height);
    for (const row of [sent, extension, init]) { row.logIndex = toHex(Number(BigInt(row.logIndex)) + Number(nonce) * 3); row.transactionHash = hash(3000 + height + Number(nonce) * 100000); }
    store(chain, [sent, extension, init]);
  } else {
    const data = encodeFunctionData({ abi: relayAbi, functionName: "relayMessage", args: [version + nonce, source.l2Bridge, source.l1Bridge, 0n, 200000n, message] });
    const withdrawalHash = keccak256(encodeAbiParameters(parseAbiParameters("uint256,address,address,uint256,uint256,bytes"), [version + nonce, source.l2Messenger, source.l1Messenger, 0n, 300000n, data]));
    const passed = eventLog(chain, source.messagePasser, "MessagePassed", { nonce: version + nonce, sender: source.l2Messenger, target: source.l1Messenger }, "uint256,uint256,bytes,bytes32", [0n, 300000n, data, withdrawalHash], 0, height);
    for (const row of [passed, init]) { row.logIndex = toHex(Number(BigInt(row.logIndex)) + Number(nonce) * 3); row.transactionHash = hash(4000 + height + Number(nonce) * 100000); }
    store(chain, [passed, init]);
  }
}
function setupArbitrum() {
  source = { ...source, protocol: "arbitrum", inbox: address(11), rollupBridge: address(12), outboxes: [address(13)], arbSys: address(100), retryableTx: address(110), l2EvmChainId: 42161,
    l2ChainId: "arbitrum", contracts: [2, 11, 12, 13].map(n => ({ chainId: "ethereum", address: address(n), runtimeCodeSha256: sha256Hex(code) })).concat([{ chainId: "arbitrum", address: address(4), runtimeCodeSha256: sha256Hex(code) }]) } as FixtureSource;
  // Remove OP-only fields; strict source parsing intentionally rejects mixed rails.
  for (const key of ["bridgeFlavor", "l1Messenger", "l2Messenger", "portal", "messagePasser"]) delete (source as unknown as Record<string, unknown>)[key];
  logs.arbitrum = [];
}
function arbWithdrawal(amount: bigint) {
  if (source.protocol !== "arbitrum") throw new Error("fixture");
  const data = encodeFunctionData({ abi: bridgeAbi, functionName: "finalizeInboundTransfer", args: [source.l1Token, user, recipient, amount, "0x"] });
  const leaf = keccak256(concat([source.l2Bridge, source.l1Bridge, toHex(1, { size: 32 }), toHex(1, { size: 32 }), toHex(100012, { size: 32 }), toHex(0, { size: 32 }), data]));
  const sent = eventLog("arbitrum", source.arbSys, "L2ToL1Tx", { destination: source.l1Bridge, hash: BigInt(leaf), position: 0n }, "address,uint256,uint256,uint256,uint256,bytes", [source.l2Bridge, 1n, 1n, 100012n, 0n, data], 0);
  const init = eventLog("arbitrum", source.l2Bridge, "WithdrawalInitiated", { from: user, to: recipient, l2ToL1Id: 0n }, "address,uint256,uint256", [source.l1Token, 0n, amount], 1);
  store("arbitrum", [sent, init]);
}
function arbDeposit(amount: bigint, nonce = 0n) {
  if (source.protocol !== "arbitrum") throw new Error("fixture");
  const data = encodeFunctionData({ abi: bridgeAbi, functionName: "finalizeInboundTransfer", args: [source.l1Token, user, recipient, amount, "0x"] });
  const packed = concat([...[
    BigInt(source.l2Bridge), 0n, 1000000n, 10n, BigInt(user), BigInt(recipient), 200000n, 2n, BigInt((data.length - 2) / 2),
  ].map(value => toHex(value, { size: 32 })), data]);
  const alias = toHex((BigInt(source.l1Bridge) + 0x1111000000000000000000000000000000001111n) % (1n << 160n), { size: 20 });
  const deliveredLog = eventLog("ethereum", source.rollupBridge, "MessageDelivered", { messageIndex: nonce, beforeInboxAcc: hash(0) },
    "address,uint8,address,bytes32,uint256,uint64", [source.inbox, 9, alias, keccak256(packed), 3n, 100012n], 0);
  const inboxLog = eventLog("ethereum", source.inbox, "InboxMessageDelivered", { messageNum: nonce }, "bytes", [packed], 1);
  const initiated = eventLog("ethereum", source.l1Bridge, "DepositInitiated", { from: user, to: recipient, sequenceNumber: nonce }, "address,uint256", [source.l1Token, amount], 2);
  for (const row of [deliveredLog, inboxLog, initiated]) { row.logIndex = toHex(Number(BigInt(row.logIndex)) + Number(nonce) * 3); row.transactionHash = hash(3001 + Number(nonce) * 100000); }
  store("ethereum", [deliveredLog, inboxLog, initiated]);
}
async function observe(checkpoint?: Parameters<typeof observeL2MessengerPending>[0]["checkpoint"]) {
  return observeL2MessengerPending({ source, headers: [header(source.chainId, pinHeight), header(source.l2ChainId, pinHeight)], chainRpcs: new Map(), checkpoint });
}
beforeEach(() => {
  finalized = false; delivered = false; withdrawalRelayed = false; missing = false; finalityHeight = 100; pinHeight = 2; initialBalance = 0n;
  logs = { ethereum: [], optimism: [] }; receipts = {}; storage = {};
  source = { kind: "evm-l2-messenger-pending", protocol: "op-stack", bridgeFlavor: "sky", sourceId: "test", chainId: "ethereum", l2ChainId: "optimism", finality: "finalized",
    l1Token: address(1), l1Bridge: address(2), l2Token: address(3), l2Bridge: address(4), escrowAddress: address(5),
    l1Messenger: address(6), l2Messenger: address(7), messagePasser: address(8), portal: address(9), l1StartBlock: 1, l2StartBlock: 1,
    scanPageBlocks: [2, 2],
    contracts: [2, 6, 9].map(n => ({ chainId: "ethereum", address: address(n), runtimeCodeSha256: sha256Hex(code) })).concat([4, 7, 8].map(n => ({ chainId: "optimism", address: address(n), runtimeCodeSha256: sha256Hex(code) }))),
    identityReads: [{ chainId: "ethereum", address: address(2), method: "eth_call", data: "0x12345678", expected: hash(55) }],
  };
  vi.mocked(fetchEvmBlockHeader).mockImplementation(async (chain, block) => header(chain, block === "finalized" ? finalityHeight : block));
  vi.mocked(fetchEvmRpcBatch).mockImplementation(async (chain, calls) => calls.map(call => {
    const name = chain!;
    if (call.method === "eth_getCode") return code;
    if (call.method === "eth_getStorageAt") return storage[`${call.params[0]}:${call.params[1]}`] ?? hash(0);
    if (call.method === "eth_getTransactionReceipt") return receipts[String(call.params[0])] ?? null;
    if (call.method === "eth_getLogs") {
      const filter = call.params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
      return missing ? [] : logs[name]!.filter(row => row.address === filter.address && filter.topics.every((value, index) => row.topics[index] === value) && BigInt(row.blockNumber) >= BigInt(filter.fromBlock) && BigInt(row.blockNumber) <= BigInt(filter.toBlock));
    }
    if (call.method !== "eth_call") throw new Error("Unexpected RPC");
    const { to, data } = call.params[0] as { to: string; data: string };
    const selector = data.slice(0, 10);
    const block = call.params[1] as { blockHash: string };
    const height = Number(BigInt(block.blockHash)) - (name === "ethereum" ? 1000 : 2000);
    if (data === "0x12345678") return hash(55);
    const bindings: Record<string, string> = {
      [toFunctionSelector("otherBridge()")]: name === "ethereum" ? source.l2Bridge : source.l1Bridge,
      [toFunctionSelector("counterpartGateway()")]: name === "ethereum" ? source.l2Bridge : source.l1Bridge,
      [toFunctionSelector("escrow()")]: source.escrowAddress,
      [toFunctionSelector("l1ToL2Token(address)")]: source.l2Token,
      [toFunctionSelector("calculateL2TokenAddress(address)")]: source.l2Token,
    };
    if (source.protocol === "op-stack") {
      bindings[toFunctionSelector("messenger()")] = name === "ethereum" ? source.l1Messenger : source.l2Messenger;
      bindings[toFunctionSelector("MESSENGER()")] = name === "ethereum" ? source.l1Messenger : source.l2Messenger;
      bindings[toFunctionSelector("OTHER_BRIDGE()")] = name === "ethereum" ? source.l2Bridge : source.l1Bridge;
      bindings[toFunctionSelector("BRIDGE()")] = source.l2Bridge;
      bindings[toFunctionSelector("REMOTE_TOKEN()")] = source.l1Token;
    }
    else { bindings[toFunctionSelector("inbox()")] = source.inbox; bindings[toFunctionSelector("bridge()")] = source.rollupBridge; }
    if (bindings[selector]) return `0x${bindings[selector]!.slice(2).padStart(64, "0")}`;
    if (selector === toFunctionSelector("balanceOf(address)") || selector === toFunctionSelector("totalSupply()")) return toHex(initialBalance, { size: 32 });
    if (selector === toFunctionSelector("messageNonce()") || selector === toFunctionSelector("delayedMessageCount()") || selector === toFunctionSelector("sendMerkleTreeState()")) {
      const producer = source.protocol === "op-stack" ? (name === "ethereum" ? source.l1Messenger : source.messagePasser) : (name === "ethereum" ? source.rollupBridge : source.arbSys);
      const producerEvent = source.protocol === "op-stack" ? (name === "ethereum" ? "SentMessage" : "MessagePassed") : (name === "ethereum" ? "MessageDelivered" : "L2ToL1Tx");
      const producerTopic = encodeEventTopics({ abi: eventAbi, eventName: producerEvent })[0];
      const count = BigInt(logs[name]!.filter(row => row.address === producer && row.topics[0] === producerTopic && Number(BigInt(row.blockNumber)) <= height).length);
      if (selector === toFunctionSelector("sendMerkleTreeState()")) return encodeAbiParameters(parseAbiParameters("uint256,bytes32,bytes32[]"), [count, hash(0), []]);
      return toHex((source.protocol === "op-stack" ? version : 0n) + count, { size: 32 });
    }
    if (selector === toFunctionSelector("successfulMessages(bytes32)")) return toHex(name === "ethereum" ? Number(withdrawalRelayed) : Number(delivered), { size: 32 });
    if (selector === toFunctionSelector("finalizedWithdrawals(bytes32)") || selector === toFunctionSelector("isSpent(uint256)")) return toHex(Number(finalized), { size: 32 });
    if (selector === toFunctionSelector("sentMessages(bytes32)")) return hash(1);
    throw new Error(`Unexpected selector ${selector} at ${to}`);
  }));
});

describe("canonical messenger pending liabilities", () => {
  it("excludes a finalized and successfully relayed withdrawal", async () => {
    opTransfer(false, 37n); finalized = true; withdrawalRelayed = true;
    const result = await observe();
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") { expect(result.amount).toBe("0"); expect(result.checkpoint.messages).toHaveLength(0); }
  });
  it("counts a proven but not finalized withdrawal without treating proof as settlement", async () => {
    opTransfer(false, 37n);
    const result = await observe();
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") { expect(result.amount).toBe("37"); expect(result.proof.withdrawalAmount).toBe("37"); }
    expect(vi.mocked(fetchEvmRpcBatch).mock.calls.flatMap(row => row[1]).some(row => JSON.stringify(row.params).includes(toFunctionSelector("finalizedWithdrawals(bytes32)")))).toBe(true);
  });
  it("retains a portal-finalized withdrawal when application relay failed", async () => {
    opTransfer(false, 37n); finalized = true;
    const result = await observe();
    expect(result.status === "accepted" && result.amount).toBe("37");
  });
  it("excludes a deposit already relayed at the exact L2 pin", async () => {
    opTransfer(true, 19n); delivered = true;
    const result = await observe();
    expect(result).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("counts pending deposits independently from burned withdrawals", async () => {
    opTransfer(true, 19n); opTransfer(false, 37n);
    const result = await observe();
    expect(result).toMatchObject({ status: "accepted", amount: "56" });
  });
  it("rejects omitted nonce history even when no token transfer is returned", async () => {
    opTransfer(true, 19n); missing = true;
    expect(await observe()).toMatchObject({ status: "rejected", reason: "nonce-missing" });
  });
  it("rejects an unfinalized holding pin", async () => {
    finalityHeight = 1;
    expect(await observe()).toMatchObject({ status: "rejected", reason: "pin-not-finalized" });
  });
  it("resumes bounded bootstrap without resetting older unfinalized liabilities", async () => {
    pinHeight = 12; opTransfer(false, 37n);
    const first = await observe();
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (!("checkpoint" in first) || !first.checkpoint) throw new Error("Missing progress checkpoint");
    const second = await observe(first.checkpoint);
    expect(second.status === "accepted" && second.amount).toBe("37");
    expect(second.status === "accepted" && second.checkpoint.cursors[1].nextBlock).toBe(13);
  });
  it("rejects a changed checkpoint predecessor instead of rescanning on a new fork", async () => {
    const first = await observe();
    if (first.status !== "accepted") throw new Error("fixture");
    first.checkpoint.cursors[0].anchorHash = hash(999);
    expect(await observe(first.checkpoint)).toMatchObject({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("rejects a nonempty initial escrow instead of assuming the challenge window is exhaustive", async () => {
    initialBalance = 1n;
    expect(await observe()).toMatchObject({ status: "rejected", reason: "initial-liabilities-not-empty" });
  });
  it("does not substitute the token bridge address for its separate Sky escrow", () => {
    expect(L2MessengerPendingReadSchema.safeParse(source).success).toBe(true);
    const reviewed = { ...source, l2ChainId: source.chainId };
    expect(L2MessengerPendingReadSchema.safeParse(reviewed).success).toBe(false);
  });
  it("counts an Arbitrum withdrawal until Outbox isSpent proves execution", async () => {
    setupArbitrum(); arbWithdrawal(41n);
    const pending = await observe();
    expect(pending.status === "accepted" && pending.amount).toBe("41");
    finalized = true;
    const settled = await observe();
    expect(settled.status === "accepted" && settled.amount).toBe("0");
  });
  it("rejects missing Arbitrum send positions using the send-tree census", async () => {
    setupArbitrum(); arbWithdrawal(41n); missing = true;
    expect(await observe()).toMatchObject({ status: "rejected", reason: "nonce-missing" });
  });
  it("proves an Arbitrum retryable deposit from Inbox bytes and only excludes its successful exact gateway redemption", async () => {
    setupArbitrum(); arbDeposit(23n);
    const pending = await observe();
    expect(pending).toMatchObject({ status: "accepted", amount: "23" });
    if (pending.status !== "accepted" || source.protocol !== "arbitrum") throw new Error("fixture");
    const id = pending.checkpoint.messages[0]!.id, retryTxHash = hash(5000);
    receipts[id] = { transactionHash: id, blockNumber: "0x1", blockHash: header("arbitrum", 1).hash, status: "0x1", logs: [] };
    const scheduled = eventLog("arbitrum", source.retryableTx, "RedeemScheduled", { ticketId: id, retryTxHash, sequenceNum: 0n },
      "uint64,address,uint256,uint256", [200000n, user, 0n, 0n], 0);
    logs.arbitrum!.push(scheduled);
    const finalization = eventLog("arbitrum", source.l2Bridge, "DepositFinalized", { l1Token: source.l1Token, from: user, to: recipient }, "uint256", [23n], 0, 2);
    finalization.transactionHash = retryTxHash;
    receipts[retryTxHash] = { transactionHash: retryTxHash, blockNumber: "0x2", blockHash: header("arbitrum", 2).hash, status: "0x1", logs: [finalization] };
    const settled = await observe(pending.checkpoint);
    expect(settled).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("does not mistake StandardBridge ETH messages for the reviewed ERC20 liability", async () => {
    if (source.protocol !== "op-stack") throw new Error("fixture");
    source.bridgeFlavor = "standard"; source.escrowAddress = source.l1Bridge;
    const data = encodeFunctionData({ abi: parseAbi(["function finalizeBridgeETH(address from,address to,uint256 amount,bytes extraData)"]), functionName: "finalizeBridgeETH", args: [user, recipient, 17n, "0x"] });
    store("ethereum", [eventLog("ethereum", source.l1Messenger, "SentMessage", { target: source.l2Bridge }, "address,bytes,uint256,uint256", [source.l1Bridge, data, version, 200000n], 0)]);
    expect(await observe()).toMatchObject({ status: "accepted", amount: "0" });
  });
});

describe("bounded dense bridge histories", () => {
  it.each([true, false])("converges across 257 same-block settled OP transfers (deposit=%s)", async deposit => {
    for (let nonce = 0; nonce < 257; nonce++) opTransfer(deposit, 1n, 1, BigInt(nonce));
    delivered = true; finalized = true; withdrawalRelayed = true;
    let checkpoint: Parameters<typeof observe>[0];
    let accepted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await observe(checkpoint);
      expect(result).not.toMatchObject({ reason: "checkpoint-capacity" });
      if (result.status === "accepted") { expect(result.amount).toBe("0"); accepted = true; break; }
      expect(result.reason).toBe("history-incomplete");
      expect(result.checkpoint).toBeDefined();
      checkpoint = result.checkpoint;
      expect(checkpoint!.messages).toHaveLength(0);
      expect(checkpoint!.cursors[deposit ? 0 : 1].resume).not.toBeNull();
    }
    expect(accepted).toBe(true);
  });
  it("resumes dense failed Arbitrum retries before admitting a later successful redemption", async () => {
    setupArbitrum(); arbDeposit(23n);
    const first = await observe();
    if (first.status !== "accepted" || source.protocol !== "arbitrum") throw new Error("fixture");
    const id = first.checkpoint.messages[0]!.id;
    receipts[id] = { transactionHash: id, blockNumber: "0x1", blockHash: header("arbitrum", 1).hash, status: "0x1", logs: [] };
    for (let index = 0; index <= 128; index++) {
      const retryTxHash = hash(6000 + index);
      logs.arbitrum!.push(eventLog("arbitrum", source.retryableTx, "RedeemScheduled", { ticketId: id, retryTxHash, sequenceNum: BigInt(index) }, "uint64,address,uint256,uint256", [200000n, user, 0n, 0n], index, 1));
      const finalization = eventLog("arbitrum", source.l2Bridge, "DepositFinalized", { l1Token: source.l1Token, from: user, to: recipient }, "uint256", [23n], 0, 2);
      finalization.transactionHash = retryTxHash;
      receipts[retryTxHash] = { transactionHash: retryTxHash, blockNumber: "0x2", blockHash: header("arbitrum", 2).hash, status: index === 128 ? "0x1" : "0x0", logs: index === 128 ? [finalization] : [] };
    }
    let checkpoint = first.checkpoint, settled = false;
    const readRetryHashes = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) {
      const before = vi.mocked(fetchEvmRpcBatch).mock.calls.length;
      const result = await observe(checkpoint);
      const retryReads = vi.mocked(fetchEvmRpcBatch).mock.calls.slice(before).flatMap(([, calls]) => calls)
        .filter(call => call.method === "eth_getTransactionReceipt" && BigInt(String(call.params[0])) >= 6000n && BigInt(String(call.params[0])) <= 6128n);
      // A successful retry has one extra receipt read for application evidence;
      // already authenticated failed prefixes are never replayed.
      expect(retryReads.length).toBeLessThanOrEqual(9);
      for (const call of retryReads) {
        const tx = String(call.params[0]);
        if (tx !== hash(6128)) { expect(readRetryHashes.has(tx)).toBe(false); readRetryHashes.add(tx); }
      }
      if (result.status === "accepted") { expect(result.amount).toBe("0"); settled = true; break; }
      expect(result.reason).toBe("history-incomplete");
      if (!result.checkpoint) throw new Error("Expected redemption prefix");
      checkpoint = result.checkpoint;
      expect(checkpoint.messages).toHaveLength(1);
      expect(checkpoint.messages[0]!.redeemResume?.logIndex).toBe((attempt + 1) * 8 - 1);
      if (attempt === 0) {
        const changed = structuredClone(checkpoint); changed.messages[0]!.redeemResume!.blockHash = hash(999);
        expect(await observe(changed)).toMatchObject({ status: "rejected", reason: "checkpoint-reorg" });
      }
    }
    expect(settled).toBe(true);
    expect(readRetryHashes.size).toBe(128);
  });
  it("rechecks a scheduled redemption whose execution is beyond the holding pin", async () => {
    setupArbitrum(); arbDeposit(23n);
    const first = await observe();
    if (first.status !== "accepted" || source.protocol !== "arbitrum") throw new Error("fixture");
    const id = first.checkpoint.messages[0]!.id, retryTxHash = hash(5000);
    receipts[id] = { transactionHash: id, blockNumber: "0x1", blockHash: header("arbitrum", 1).hash, status: "0x1", logs: [] };
    logs.arbitrum!.push(eventLog("arbitrum", source.retryableTx, "RedeemScheduled", { ticketId: id, retryTxHash, sequenceNum: 0n }, "uint64,address,uint256,uint256", [200000n, user, 0n, 0n], 0, 1));
    const finalization = eventLog("arbitrum", source.l2Bridge, "DepositFinalized", { l1Token: source.l1Token, from: user, to: recipient }, "uint256", [23n], 0, 3);
    finalization.transactionHash = retryTxHash;
    receipts[retryTxHash] = { transactionHash: retryTxHash, blockNumber: "0x3", blockHash: header("arbitrum", 3).hash, status: "0x1", logs: [finalization] };
    const waiting = await observe(first.checkpoint);
    expect(waiting).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (waiting.status !== "rejected" || !waiting.checkpoint) throw new Error("Expected deferred execution");
    expect(waiting.checkpoint.messages[0]).toMatchObject({ redeemNextBlock: 1, redeemResume: null });
    pinHeight = 3;
    expect(await observe(waiting.checkpoint)).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("gives both dense source directions a resumable opportunity", async () => {
    for (let nonce = 0; nonce < 64; nonce++) { opTransfer(true, 1n, 1, BigInt(nonce)); opTransfer(false, 1n, 1, BigInt(nonce)); }
    delivered = true; finalized = true; withdrawalRelayed = true;
    const first = await observe();
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Expected two resumable streams");
    for (const cursor of first.checkpoint.cursors) expect(cursor.resume?.nextNonce).toBe("32");
    expect(first.checkpoint.messages).toHaveLength(0);
  });
  it("never discards 257 genuinely unresolved transfers to fit checkpoint capacity", async () => {
    for (let nonce = 0; nonce < 257; nonce++) opTransfer(true, 1n, 1, BigInt(nonce));
    let checkpoint: Parameters<typeof observe>[0];
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await observe(checkpoint);
      expect(result).toMatchObject({ status: "rejected", reason: "history-incomplete" });
      if (result.status !== "rejected" || !result.checkpoint) throw new Error("Expected resumable unresolved prefix");
      checkpoint = result.checkpoint;
      expect(checkpoint.messages).toHaveLength((attempt + 1) * 32);
    }
    expect(await observe(checkpoint)).toMatchObject({ status: "rejected", reason: "checkpoint-capacity" });
    delivered = true;
    expect(await observe(checkpoint)).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("authenticates skipped same-block nonces before resuming and rejects changed settlement pins", async () => {
    for (let nonce = 0; nonce < 33; nonce++) opTransfer(true, 1n, 1, BigInt(nonce));
    delivered = true;
    const first = await observe();
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Expected partial block");
    first.checkpoint.cursors[0].resume!.nextNonce = "31";
    expect(await observe(first.checkpoint)).toMatchObject({ status: "rejected", reason: "nonce-missing" });
    first.checkpoint.cursors[0].resume!.nextNonce = "32";
    pinHeight = 3;
    const original = vi.mocked(fetchEvmBlockHeader).getMockImplementation()!;
    vi.mocked(fetchEvmBlockHeader).mockImplementation(async (chain, n, options) => chain === "optimism" && n === 2
      ? { ...header(chain, n), hash: hash(999) } : original(chain, n, options));
    expect(await observe(first.checkpoint)).toMatchObject({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("makes bounded Arbitrum retryable progress without treating incomplete redemption history as settled", async () => {
    setupArbitrum();
    for (let nonce = 0; nonce < 257; nonce++) arbDeposit(1n, BigInt(nonce));
    let checkpoint: Parameters<typeof observe>[0];
    let accepted = false;
    // Each discovered ticket is initially pending; its next attempt supplies an
    // authenticated exact redemption. More than eight settle per whole history,
    // so the shared redemption-page budget must persist, prune, and resume.
    for (let attempt = 0; attempt < 65; attempt++) {
      const before = vi.mocked(fetchEvmRpcBatch).mock.calls.length;
      const result = await observe(checkpoint);
      const logReads = vi.mocked(fetchEvmRpcBatch).mock.calls.slice(before).flatMap(([, calls]) => calls).filter(call => call.method === "eth_getLogs");
      expect(logReads.length).toBeLessThanOrEqual(8);
      expect(result).not.toMatchObject({ reason: "checkpoint-capacity" });
      if (result.status === "accepted" && result.amount === "0") { accepted = true; break; }
      checkpoint = result.checkpoint;
      expect(checkpoint).toBeDefined();
      for (const message of checkpoint!.messages) {
        const id = message.id, retryTxHash = hash(9000 + Number(message.nonce));
        if (receipts[id]) continue;
        receipts[id] = { transactionHash: id, blockNumber: "0x1", blockHash: header("arbitrum", 1).hash, status: "0x1", logs: [] };
        if (source.protocol !== "arbitrum") throw new Error("fixture");
        logs.arbitrum!.push(eventLog("arbitrum", source.retryableTx, "RedeemScheduled", { ticketId: id, retryTxHash, sequenceNum: 0n }, "uint64,address,uint256,uint256", [200000n, user, 0n, 0n], Number(message.nonce), 1));
        const finalization = eventLog("arbitrum", source.l2Bridge, "DepositFinalized", { l1Token: source.l1Token, from: user, to: recipient }, "uint256", [1n], 0, 2);
        finalization.transactionHash = retryTxHash;
        receipts[retryTxHash] = { transactionHash: retryTxHash, blockNumber: "0x2", blockHash: header("arbitrum", 2).hash, status: "0x1", logs: [finalization] };
      }
    }
    expect(accepted).toBe(true);
  });
});

describe("messenger implementation admission", () => {
  it("requires both the implementation runtime census and its exact proxy slot binding", async () => {
    const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    storage[`${source.l1Bridge}:${slot}`] = hash(17);
    expect(await observe()).toMatchObject({ status: "rejected", reason: "implementation-unreviewed" });
    source.contracts.push({ chainId: source.chainId, address: address(17), runtimeCodeSha256: sha256Hex(code) });
    source.identityReads.push({ chainId: source.chainId, address: source.l1Bridge, method: "eth_getStorageAt", data: slot, expected: hash(17) });
    expect(await observe()).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("rejects unsupported beacon indirection rather than trusting the proxy runtime", async () => {
    const slot = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
    storage[`${source.l1Bridge}:${slot}`] = hash(17);
    expect(await observe()).toMatchObject({ status: "rejected", reason: "proxy-beacon-unsupported" });
  });
});

describe("messenger proof admission into economic supply", () => {
  it("admits a conserved pending remainder only with both exact holding pins and reviewed token/escrow joins", async () => {
    opTransfer(false, 37n);
    const pending = await observe();
    if (pending.status !== "accepted") throw new Error("fixture");
    const clock = header(source.chainId, pinHeight).timestamp;
    const deployments: ReviewedEconomicSupplyPlan["deployments"] = [source.chainId, source.l2ChainId].map((chainId, i) => {
      const token = i === 0 ? source.l1Token : source.l2Token;
      return { deploymentKey: `${chainId}:${token}`, chainId, address: token, holdingKind: "contract", amountBasis: "fixed-token-units",
        decimals: 0, routeId: `${chainId}:${token}`, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null };
    });
    const plan: ReviewedEconomicSupplyPlan = { assetId: "alpha", reviewer: "reviewer", reviewedAtSec: clock - 60, expiresAtSec: clock + 86400,
      evidenceUrls: ["https://issuer.example/accounting"], economicScope: "Complete exact bridge token census", sourceId: "reference",
      accountingFamily: "lock-mint", commonClaimUnit: "claim", exhaustive: true, inFlightTreatment: "observed-reconciled", deployments,
      excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
      escrows: [{ id: "bridge-escrow", canonicalDeploymentKey: deployments[0]!.deploymentKey, account: source.escrowAddress,
        receiptDeploymentKeys: [deployments[1]!.deploymentKey], receiptClaimSources: [], independentReceiptLiability: false, inFlightSource: source }],
    };
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(plan).success).toBe(true);
    const routes = deployments.map(row => ({ id: row.deploymentKey, destinationChain: row.chainId, contractAddress: row.address!,
      protocol: "canonical-bridge", issuanceModel: "bridge-representation", routeClass: "canonical", riskTier: "canonical-rollup-bridge",
      semantics: "lock-mint", scope: "peripheral", reviewDisposition: "reviewed" })) as NonNullable<BridgeRouteRiskProfile["routes"]>;
    const meta = { contracts: deployments.map(row => ({ chain: row.chainId, address: row.address!, decimals: row.decimals! })),
      bridgeRouteRisk: { tier: "canonical-rollup-bridge", summary: "Exact reviewed token pair", routes } } as Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
    const observed = (id: string, i: number, amount: string): EconomicSupplyObservation => {
      const pin = header(i === 0 ? source.chainId : source.l2ChainId, pinHeight);
      return { id, deploymentKey: deployments[i]!.deploymentKey, amount, observedAtSec: pin.timestamp, anchor: String(pin.number),
        anchorHash: pin.hash, responseSha256: sha256Hex("test-state") };
    };
    const inFlight = observed("in-flight:bridge-escrow", 0, pending.amount);
    inFlight.l2MessengerPendingProof = pending.proof; inFlight.responseSha256 = pending.responseSha256;
    const input = { plan, meta, baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source",
      registryFingerprint: "d".repeat(64), clockSec: clock, aggregate: { supplyUsd: 100, sourceGeneration: "source", observedAtSec: clock },
      referencePrice: { sourceId: "reference", sourceGeneration: "price", observedAtSec: clock, value: "1", responseSha256: sha256Hex("price") },
      conversions: [], observations: [observed(deployments[0]!.deploymentKey, 0, "100"), observed(deployments[1]!.deploymentKey, 1, "20"), observed("bridge-escrow", 0, "57")],
      inFlight: [inFlight] };
    const packet = deriveReviewedEconomicDeploymentPartition(input);
    expect(packet?.aggregate.supplyUsd).toBe(100);
    expect(packet?.deployments.map(row => row.currentSupplyUsd)).toEqual([43, 20]);
    expect(packet?.unattributedSupplyUsd).toBe(37);
    input.observations[1]!.anchorHash = hash(99);
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
    plan.escrows[0]!.account = source.l1Bridge;
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(plan).success).toBe(false);
  });
});
