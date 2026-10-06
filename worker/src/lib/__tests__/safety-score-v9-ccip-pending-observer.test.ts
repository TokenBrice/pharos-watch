import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { CcipPendingReadSchema, type CcipPendingCheckpoint, type CcipPendingRead, type EconomicSupplyObservation, type ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import { observeCcipPending, authenticateCcipPendingObservation } from "../safety-score-v9/ccip-pending-observer";
import { fetchEvmBlockHeader, fetchEvmRpcBatch } from "../evm-rpc";
import { fetchJsonWithRetry } from "../fetch-retry";
import { getCache, setCache } from "../db-cache";
import type { StablecoinMeta } from "@shared/types/core";
import { deriveReviewedEconomicDeploymentPartition } from "../safety-score-v9/supply-attribution-contract";

vi.mock("../evm-rpc", () => ({ fetchEvmBlockHeader: vi.fn(), fetchEvmRpcBatch: vi.fn() }));
vi.mock("../fetch-retry", () => ({ fetchJsonWithRetry: vi.fn() }));
vi.mock("../db-cache", () => ({ getCache: vi.fn(), setCache: vi.fn() }));
type SendLog = { address: string; topics: string[]; data: `0x${string}`; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; removed: boolean };
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const word = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const CODE = "0x60016000";
const MESSAGE_16 = "((bytes32 messageId,uint64 sourceChainSelector,uint64 destChainSelector,uint64 sequenceNumber,uint64 nonce) header,address sender,bytes data,bytes receiver,bytes extraArgs,address feeToken,uint256 feeTokenAmount,uint256 feeValueJuels,(address sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint256 amount,bytes destExecData)[] tokenAmounts)";
const MESSAGE_15 = "(uint64 sourceChainSelector,address sender,address receiver,uint64 sequenceNumber,uint256 gasLimit,bool strict,uint64 nonce,address feeToken,uint256 feeTokenAmount,bytes data,(address token,uint256 amount)[] tokenAmounts,bytes[] sourceTokenData,bytes32 messageId)";
const SEND_16 = keccak256(toHex("CCIPMessageSent(uint64,uint64,((bytes32,uint64,uint64,uint64,uint64),address,bytes,bytes,bytes,address,uint256,uint256,(address,bytes,bytes,uint256,bytes)[]))"));
const SEND_15 = keccak256(toHex("CCIPSendRequested((uint64,address,address,uint64,uint256,bool,uint64,address,uint256,bytes,(address,uint256)[],bytes[],bytes32))"));
const EXECUTION_16 = keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,bytes32,uint8,bytes,uint256)"));
const SEND_20 = keccak256(toHex("CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])"));
const EXECUTION_20 = keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)"));
type CcipVersion = "1.5" | "1.6" | "2.0.0";
function source(version: CcipVersion = "1.6"): CcipPendingRead {
  const side = (chainId: string, selector: string, token: number, pool: number) => ({ chainId, chainSelector: selector, tokenAddress: addr(token), tokenPoolAddress: addr(pool), tokenPoolRuntimeCodeSha256: sha256Hex(CODE), decimals: 6 });
  return { kind: "evm-ccip-pending", sourceId: "ccip-test", chainId: "ethereum", finality: "finalized", amountDecimals: 6,
    lanes: [{ id: "eth-base", version, source: side("ethereum", "1", 10, 11), destination: side("base", "2", 20, 21),
      onRampAddress: addr(30), offRampAddress: addr(31), onRampRuntimeCodeSha256: sha256Hex(CODE), offRampRuntimeCodeSha256: sha256Hex(CODE), sourceStartBlock: 100 }] };
}
function send(sequence: number, amount = 10n, block = 100, version: "1.5" | "1.6" = "1.6", applicationData: `0x${string}` = "0x", destinationSelector = 2n) {
  const messageId = word(1000 + sequence);
  const data = version === "1.6" ? encodeAbiParameters(parseAbiParameters(MESSAGE_16), [{
    header: { messageId, sourceChainSelector: 1n, destChainSelector: destinationSelector, sequenceNumber: BigInt(sequence), nonce: 0n },
    sender: addr(40), data: applicationData, receiver: word(40), extraArgs: "0x", feeToken: addr(41), feeTokenAmount: 1n, feeValueJuels: 1n,
    tokenAmounts: [{ sourcePoolAddress: addr(11), destTokenAddress: word(20), extraData: "0x", amount, destExecData: "0x" }],
  }]) : encodeAbiParameters(parseAbiParameters(MESSAGE_15), [{ sourceChainSelector: 1n, sender: addr(40), receiver: addr(40), sequenceNumber: BigInt(sequence), gasLimit: 0n, strict: false, nonce: 0n, feeToken: addr(41), feeTokenAmount: 1n, data: applicationData,
    tokenAmounts: [{ token: addr(10), amount }], sourceTokenData: [encodeAbiParameters(parseAbiParameters("(bytes sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint32 destGasAmount)"), [{ sourcePoolAddress: word(11), destTokenAddress: word(20), extraData: "0x", destGasAmount: 90000 }])], messageId }]);
  return { address: addr(30), topics: version === "1.6" ? [SEND_16, word(destinationSelector), word(sequence)] : [SEND_15], data,
    blockNumber: `0x${block.toString(16)}`, blockHash: word(block), transactionHash: word(2000 + sequence), logIndex: `0x${sequence.toString(16)}`, removed: false };
}
function send20(sequence: number, amount = 10n, block = 100, onRamp = 30, offRamp = 31, applicationData: `0x${string}` = "0x", destinationSelector = 2n): SendLog {
  const field = (value: string, bytes = 1) => ((value.length - 2) / 2).toString(16).padStart(bytes * 2, "0") + value.slice(2);
  const token = "01" + amount.toString(16).padStart(64, "0") + field(word(11)) + field(word(10)) +
    field(addr(20)) + field(addr(40)) + "0000";
  const encoded = `0x01${1n.toString(16).padStart(16, "0")}${destinationSelector.toString(16).padStart(16, "0")}${sequence.toString(16).padStart(16, "0")}${"00".repeat(44)}` +
    field(word(onRamp)) + field(addr(offRamp)) + field(word(40)) + field(addr(40)) + "0000" + field(`0x${token}`, 2) + field(applicationData, 2);
  const payload = `0x${encoded.slice(2)}` as `0x${string}`, messageId = keccak256(payload);
  return { address: addr(onRamp), topics: [SEND_20, word(destinationSelector), word(40), messageId],
    data: encodeAbiParameters(parseAbiParameters("address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[]"), [addr(41), amount + 1n, payload, [], []]),
    blockNumber: `0x${block.toString(16)}`, blockHash: word(block), transactionHash: word(2000 + sequence), logIndex: `0x${sequence.toString(16)}`, removed: false };
}
function economicInput(read: CcipPendingRead, pending: EconomicSupplyObservation) {
  const canonical = `ethereum:${addr(10)}`, remote = `base:${addr(20)}`;
  const plan: ReviewedEconomicSupplyPlan = {
    assetId: "alpha", reviewer: "reviewer", reviewedAtSec: 1, expiresAtSec: 2000,
    evidenceUrls: ["https://issuer.example/ccip"], economicScope: "Exact escrow, receipts and pending token claims",
    sourceId: "reference", accountingFamily: "lock-mint", commonClaimUnit: "claim", exhaustive: true, inFlightTreatment: "observed-reconciled",
    deployments: [{ chainId: "ethereum", address: addr(10) }, { chainId: "base", address: addr(20) }].map(({ chainId, address }) => ({ deploymentKey: `${chainId}:${address}`, chainId, address, holdingKind: "contract",
      amountBasis: "fixed-token-units", decimals: 6, routeId: `${chainId}:${address}`, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null })),
    excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
    escrows: [{ id: "bridge-escrow", canonicalDeploymentKey: canonical, account: addr(11), receiptDeploymentKeys: [remote], receiptClaimSources: [], independentReceiptLiability: false, inFlightSource: read }],
  };
  const meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk"> = {
    contracts: plan.deployments.map(row => ({ chain: row.chainId, address: row.address!, decimals: row.decimals! })),
    bridgeRouteRisk: { tier: "external-validated-network", summary: "Exact reviewed CCIP token paths", reviewedAt: "1970-01-01", reviewer: "reviewer", confidence: "verified", routes: plan.deployments.map(row => ({
      id: row.deploymentKey, destinationChain: row.chainId, contractAddress: row.address!, protocol: "CCIP", issuanceModel: "bridge-representation",
      routeClass: "canonical", riskTier: "external-validated-network", semantics: "lock-mint", scope: "peripheral", reviewDisposition: "reviewed",
    })) },
  };
  const observation = (id: string, deploymentKey: string, amount: string): EconomicSupplyObservation => ({ id, deploymentKey, amount, observedAtSec: 1000, anchor: "105", anchorHash: word(105), responseSha256: "b".repeat(64) });
  return { plan, meta, baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "d".repeat(64), clockSec: 1000,
    aggregate: { supplyUsd: 100, sourceGeneration: "source", observedAtSec: 1000 },
    referencePrice: { sourceId: "reference", sourceGeneration: "price", observedAtSec: 1000, value: "1", responseSha256: "e".repeat(64) }, conversions: [],
    observations: [observation(canonical, canonical, "100000000"), observation(remote, remote, "19000000"), observation("bridge-escrow", canonical, "20000000")],
    inFlight: [pending],
  };
}
let protocol: CcipVersion;
let sent: SendLog[], executed: SendLog[], states: Record<string, number>, expectedNext: number;
let pinNumber: number, finalized: number, indexed: string[], receiptLogs: SendLog[] | undefined;
let activeRead: CcipPendingRead;
let peersRemoved: boolean;
let logRanges: Array<{ chain: string; from: number; to: number }>;
function input(read = source(), checkpoint?: CcipPendingCheckpoint) {
  activeRead = read;
  protocol = read.lanes[0]!.version;
  const chains = [...new Set(read.lanes.flatMap(lane => [lane.source.chainId, lane.destination.chainId]))];
  return { source: read, clockSec: 1000, headers: new Map(chains.map(chain => [chain, { number: pinNumber, timestamp: 1000, hash: word(pinNumber) }])), chainRpcs: new Map(), checkpoint };
}
beforeEach(() => {
  vi.resetAllMocks(); sent = [send(1)]; executed = []; states = {}; expectedNext = 2;
  protocol = "1.6";
  peersRemoved = false;
  pinNumber = 105; finalized = 20000; indexed = []; receiptLogs = undefined; logRanges = [];
  vi.mocked(getCache).mockResolvedValue(null);
  vi.mocked(fetchEvmBlockHeader).mockImplementation(async (_chain, number) => {
    const n = number === "finalized" ? finalized : Number(number);
    return { number: n, timestamp: 1000, hash: word(n) };
  });
  vi.mocked(fetchJsonWithRetry).mockImplementation(async url => {
    const id = url.slice(url.lastIndexOf("/") + 1);
    if (id.length === 0) throw new Error("Unexpected empty fixture message URL");
    const log = sent.find(row => row.topics.includes(id));
    return { response: new Response("{}"), body: url.includes("?") ? { data: indexed.map(messageId => ({ messageId })), pagination: { hasNextPage: false } } : { onramp: log?.address ?? addr(30), sendTransactionHash: log?.transactionHash ?? word(2000 + Number(BigInt(id) - 1000n)) } };
  });
  vi.mocked(fetchEvmRpcBatch).mockImplementation(async (chain, calls) => calls.map(request => {
    if (typeof chain !== "string") throw new Error("Unexpected missing fixture RPC chain");
    if (request.method === "eth_getCode") {
      const block = request.params[1];
      return block && typeof block === "object" && "blockHash" in block && block.blockHash === word(99) ? "0x" : CODE;
    }
    if (request.method === "eth_getBlockByNumber") {
      const number = request.params[0];
      if (typeof number !== "string") throw new Error("Unexpected fixture block number");
      return { number, hash: word(BigInt(number)) };
    }
    if (request.method === "eth_getLogs") {
      const filter = request.params[0];
      if (!filter || typeof filter !== "object" ||
        !("fromBlock" in filter) || typeof filter.fromBlock !== "string" ||
        !("toBlock" in filter) || typeof filter.toBlock !== "string" ||
        !("address" in filter) || !(typeof filter.address === "string" || Array.isArray(filter.address)) ||
        !("topics" in filter) || !Array.isArray(filter.topics)) throw new Error("Unexpected fixture log filter");
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      logRanges.push({ chain, from, to });
      const addresses = typeof filter.address === "string" ? [filter.address] : filter.address;
      const topics = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]];
      return [...sent, ...executed].filter(row => addresses.includes(row.address) && topics.includes(row.topics[0]) &&
        Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= to)
        .sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    }
    if (request.method === "eth_getTransactionReceipt") {
      const tx = request.params[0];
      if (typeof tx !== "string") throw new Error("Unexpected fixture transaction hash");
      const log = sent.find(row => row.transactionHash === tx);
      return { transactionHash: tx, status: "0x1", blockNumber: log?.blockNumber ?? "0x64", blockHash: log?.blockHash ?? word(100), logs: receiptLogs ?? (log ? [log] : []) };
    }
    const body = request.params[0];
    if (!body || typeof body !== "object" ||
      !("to" in body) || typeof body.to !== "string" ||
      !("data" in body) || typeof body.data !== "string") throw new Error("Unexpected fixture eth_call");
    const { to, data } = body;
    const selector = data.slice(0, 10);
    if (selector === toFunctionSelector("getToken()")) return word(chain === "ethereum" ? 10 : 20);
    if (selector === toFunctionSelector("decimals()")) return word(6);
    const at = request.params[1];
    const oldPeerPin = at && typeof at === "object" && "blockHash" in at && at.blockHash === word(102);
    if (peersRemoved && !oldPeerPin && selector === toFunctionSelector("getRemoteToken(uint64)")) return encodeAbiParameters(parseAbiParameters("bytes"), ["0x"]);
    if (peersRemoved && !oldPeerPin && selector === toFunctionSelector("getRemotePools(uint64)")) return encodeAbiParameters(parseAbiParameters("bytes[]"), [[]]);
    if (selector === toFunctionSelector("getRemoteToken(uint64)")) return encodeAbiParameters(parseAbiParameters("bytes"), [word(chain === "ethereum" ? 20 : 10)]);
    if (selector === toFunctionSelector("getRemotePools(uint64)")) return encodeAbiParameters(parseAbiParameters("bytes[]"), [[word(chain === "ethereum" ? 21 : 11)]]);
    if (selector === toFunctionSelector("getStaticConfig()")) {
      if (chain === "ethereum" && protocol === "1.5") return encodeAbiParameters(parseAbiParameters("(address,uint64,uint64,uint64,uint96,address,address,address)"), [[addr(50), 1n, 2n, 0n, 0n, addr(0), addr(51), addr(52)]]);
      if (chain === "ethereum" && (protocol === "2.0.0" || to === addr(32))) return encodeAbiParameters(parseAbiParameters("(uint64,address,uint32,address)"), [[1n, addr(50), 1, addr(52)]]);
      if (chain === "base" && (protocol === "2.0.0" || to === addr(33))) return encodeAbiParameters(parseAbiParameters("(uint64,uint16,address,address,uint32)"), [[2n, 1, addr(51), addr(52), 1]]);
      if (chain === "ethereum") return encodeAbiParameters(parseAbiParameters("(uint64,address,address,address)"), [[1n, addr(50), addr(51), addr(52)]]);
      return encodeAbiParameters(parseAbiParameters("(address,uint64,uint64,address,address,address,address)"), [[addr(50), 2n, 1n, addr(30), addr(0), addr(51), addr(52)]]);
    }
    if (selector === toFunctionSelector("getSourceChainConfig(uint64)")) return protocol === "2.0.0" || to === addr(33)
      ? encodeAbiParameters(parseAbiParameters("(address,bool,bytes[],address[],address[])"), [[addr(50), true, [word(to === addr(33) ? 32 : 30)], [], []]])
      : encodeAbiParameters(parseAbiParameters("(address,bool,uint64,bool,bytes)"), [[addr(50), true, 1n, false,
        `0x${(activeRead.lanes.find(lane => lane.offRampAddress === to)?.onRampAddress ?? addr(30)).slice(2).padStart(64, "0")}`]]);
    if (selector === toFunctionSelector("getExpectedNextSequenceNumber(uint64)") || selector === toFunctionSelector("getExpectedNextSequenceNumber()") || selector === toFunctionSelector("getExpectedNextMessageNumber(uint64)")) return word(expectedNext);
    if (selector === toFunctionSelector("getExecutionState(uint64,uint64)") || selector === toFunctionSelector("getExecutionState(uint64)")) return word(states[BigInt(`0x${data.slice(-64)}`).toString()] ?? 0);
    if (selector === toFunctionSelector("getExecutionState(bytes32)")) return word(states[`0x${data.slice(-64)}`] ?? 0);
    throw new Error(`Unexpected RPC selector ${selector}`);
  }));
});

describe("authenticated CCIP pending quantities", () => {
  it("completes an indexer omission through consecutive source logs", async () => {
    const result = await observeCcipPending(input());
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error(result.reason);
    expect(result.amount).toBe("10"); expect(result.proof.lanes[0]).toMatchObject({ pendingCount: 1, failedCount: 0, lastSequence: "1" });
  });
  it.each(["1.6", "2.0.0"] as const)("excludes a large foreign %s message on the shared ramp without blocking our census", async version => {
    const data = `0x${"ab".repeat(20000)}` as `0x${string}`;
    const own = version === "1.6" ? send(1) : send20(1);
    const foreign = version === "1.6" ? send(1, 90n, 100, version, data, 3n) : send20(1, 90n, 100, 30, 31, data, 3n);
    foreign.logIndex = "0x2";
    sent = [own, foreign];
    const result = await observeCcipPending(input(source(version)));
    expect(result).toMatchObject({ status: "accepted", amount: "10", proof: { lanes: [{ pendingCount: 1, lastSequence: "1" }] } });
  });
  it.each(["1.5", "1.6", "2.0.0"] as const)("rejects an oversized matched %s message rather than skipping its liability", async version => {
    const data = `0x${"ab".repeat(20000)}` as `0x${string}`;
    sent = [version === "2.0.0" ? send20(1, 10n, 100, 30, 31, data) : send(1, 10n, 100, version, data)];
    const result = await observeCcipPending(input(source(version)));
    expect(logRanges.length).toBeGreaterThan(0);
    expect(result.status).toBe("rejected");
    expect(result).not.toHaveProperty("amount");
  });
  it.each(["removed", "missing-selector", "malformed-data", "noncanonical"] as const)("rejects a %s foreign log instead of treating invalid evidence as irrelevant", async fault => {
    const foreign = send(1, 90n, 100, "1.6", "0x", 3n);
    foreign.logIndex = "0x2";
    if (fault === "removed") foreign.removed = true;
    else if (fault === "missing-selector") foreign.topics = [SEND_16];
    else if (fault === "malformed-data") foreign.data = "0x0";
    else foreign.blockHash = word(999);
    sent = [send(1), foreign];
    const result = await observeCcipPending(input());
    expect(result.status).toBe("rejected");
    expect(result).not.toHaveProperty("amount");
  });
  it("excludes successfully executed messages without trusting the indexer status", async () => {
    states["1"] = 2; indexed = [word(1001)];
    const result = await observeCcipPending(input());
    expect(result).toMatchObject({ status: "accepted", amount: "0", proof: { lanes: [{ pendingCount: 0 }] } });
  });
  it("keeps failed execution owed", async () => {
    states["1"] = 3;
    expect(await observeCcipPending(input())).toMatchObject({ status: "accepted", amount: "10", proof: { lanes: [{ pendingCount: 1, failedCount: 1 }] } });
  });
  it("rejects a missing intermediate sequence rather than returning a partial amount", async () => {
    sent = [send(1), send(3, 20n, 101)]; expectedNext = 4;
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "sequence-gap" });
  });
  it("rejects a missing trailing send with pinned expected-next continuity", async () => {
    expectedNext = 3;
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "send-census-mismatch" });
  });
  it("rejects an indexer-listed message absent from its on-chain receipt", async () => {
    indexed = [word(1001)]; receiptLogs = [];
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "indexer-send-unproved" });
  });
  it("rejects stale and future pins", async () => {
    const stale = input(); stale.clockSec = 100000;
    expect(await observeCcipPending(stale)).toMatchObject({ status: "rejected", reason: "pin-stale-or-future" });
    const future = input(); future.clockSec = 999;
    expect(await observeCcipPending(future)).toMatchObject({ status: "rejected", reason: "pin-stale-or-future" });
  });
  it("rejects unfinalized pins", async () => {
    finalized = 104;
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "pin-not-finalized" });
  });
  it("rejects transient IN_PROGRESS rather than discarding an owed message", async () => {
    states["1"] = 1;
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "execution-state-invalid" });
  });
  it("resumes bounded scans without rescanning the completed prefix or double counting", async () => {
    pinNumber = 16105; sent = [send(1, 10n, 100), send(2, 20n, 16100)]; expectedNext = 3;
    const first = await observeCcipPending(input());
    expect(first.status).toBe("rejected");
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Missing incomplete checkpoint");
    expect(first.reason).toBe("history-incomplete"); expect(first).not.toHaveProperty("amount");
    expect(first.checkpoint.lanes[0]!.sent.nextBlock).toBe(16100);
    logRanges = [];
    const resumed = await observeCcipPending(input(source(), first.checkpoint));
    expect(resumed).toMatchObject({ status: "accepted", amount: "30", proof: { lanes: [{ pendingCount: 2, lastSequence: "2" }] } });
    expect(logRanges.filter(range => range.chain === "ethereum")).toEqual([{ chain: "ethereum", from: 16100, to: 16105 }]);
  });
  it("persists authenticated bootstrap before a later lane aborts and resumes only incomplete history", async () => {
    const read = source(), template = read.lanes[0]!;
    read.lanes.push({ ...template, id: "later-lane", onRampAddress: addr(34), offRampAddress: addr(35) });
    sent = [send(1), { ...send(1), address: addr(34), logIndex: "0x2" }];
    pinNumber = 16105;
    let saved: string | null = null;
    const writes: CcipPendingCheckpoint[] = [];
    vi.mocked(getCache).mockImplementation(async () => saved === null ? null : { value: saved, updatedAt: 1000 });
    vi.mocked(setCache).mockImplementation(async (_db, _key, value) => {
      saved = value; writes.push(JSON.parse(value) as CcipPendingCheckpoint);
    });
    const db = {} as D1Database, controller = new AbortController(), timeout = new Error("asset-timeout");
    const baseMock = vi.mocked(fetchEvmRpcBatch).getMockImplementation()!;
    vi.mocked(fetchEvmRpcBatch).mockImplementation(async (chain, requests, options) => {
      if (requests.some(request => request.method === "eth_getCode" && request.params[0] === addr(34))) {
        controller.abort(timeout); throw timeout;
      }
      return baseMock(chain, requests, options);
    });
    await expect(observeCcipPending({ ...input(read), db, signal: controller.signal })).rejects.toBe(timeout);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.lanes).toHaveLength(1);
    expect(writes[0]!.lanes[0]!.sent).toMatchObject({ nextBlock: 100, anchor: 99, anchorHash: word(99) });
    expect(logRanges).toHaveLength(0);

    vi.mocked(fetchEvmRpcBatch).mockImplementation(baseMock);
    vi.mocked(fetchEvmRpcBatch).mockClear();
    pinNumber += 900;
    const resumed = await observeCcipPending({ ...input(read), db });
    expect(resumed).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    expect(resumed).not.toHaveProperty("amount");
    const latest = writes[writes.length - 1]!;
    expect(latest.lanes).toHaveLength(2);
    expect(latest.lanes.every(lane => lane.sent.nextBlock > 100)).toBe(true);
    expect(vi.mocked(fetchEvmRpcBatch).mock.calls.some(([, requests]) => requests.some(request => {
      const block = request.params[1];
      return request.method === "eth_getCode" && request.params[0] === addr(30) &&
        block !== null && typeof block === "object" && "blockHash" in block && block.blockHash === word(99);
    }))).toBe(false);

    const corrupted = writes[0]!;
    corrupted.lanes[0]!.sent.anchorHash = word(9999);
    expect(await observeCcipPending(input(read, corrupted))).toMatchObject({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("re-authenticates runtime at a new attempt's pin instead of trusting the checkpoint", async () => {
    const first = await observeCcipPending(input());
    if (first.status !== "accepted") throw new Error(first.reason);
    const baseMock = vi.mocked(fetchEvmRpcBatch).getMockImplementation()!;
    vi.mocked(fetchEvmRpcBatch).mockImplementation(async (chain, requests, options) => {
      const values = await baseMock(chain, requests, options);
      return values?.map((value, i) => requests[i]!.method === "eth_getCode" && requests[i]!.params[0] === addr(11) ? "0x6002" : value) ?? null;
    });
    pinNumber++;
    expect(await observeCcipPending(input(source(), first.checkpoint))).toMatchObject({ status: "rejected", reason: "runtime-mismatch" });
  });
  it.each([5, 12, 24, 42])("converges %i independent histories despite advancing finalized pins", async laneCount => {
    const read = source(), template = read.lanes[0]!;
    read.lanes = Array.from({ length: laneCount }, (_, i) => ({ ...template, id: `lane-${i}`,
      onRampAddress: addr(100 + i), offRampAddress: addr(200 + i) }));
    sent = read.lanes.map((lane, i) => ({ ...send(1), address: lane.onRampAddress,
      transactionHash: word(3000 + i), logIndex: `0x${i.toString(16)}` }));
    pinNumber = 16105; finalized = 100000;
    const first = await observeCcipPending(input(read));
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    expect(first).not.toHaveProperty("amount");
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Missing shared-page checkpoint");
    expect(first.checkpoint.lanes).toHaveLength(laneCount);
    expect(first.checkpoint.lanes.every(lane => lane.sent.nextBlock === 16100)).toBe(true);
    expect(logRanges).toHaveLength(8);
    const pinnedRequests = vi.mocked(fetchEvmRpcBatch).mock.calls.flatMap(([chain, requests]) => requests
      .filter(request => request.method === "eth_call" || request.method === "eth_getCode")
      .map(request => stableJsonStringifyV1({ chain, request })));
    expect(new Set(pinnedRequests).size).toBe(pinnedRequests.length);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls).toHaveLength(1);
    pinNumber += 900; logRanges = [];
    const result = await observeCcipPending(input(read, first.checkpoint));
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error(result.reason);
    expect(result.amount).toBe(String(laneCount * 10));
    expect(result.proof.lanes.every(lane => lane.pendingCount === 1 && lane.lastSequence === "1")).toBe(true);
    expect(result.proof.pins.every(pin => pin.anchor === pinNumber)).toBe(true);
    expect(result.checkpoint.lanes.every(lane => lane.sent.nextBlock === pinNumber + 1 && lane.executed.nextBlock === pinNumber + 1)).toBe(true);
    expect(logRanges.length).toBeLessThanOrEqual(8);
    expect(logRanges[0]!.chain).toBe("base");
  });
  it("finishes a six-chain moving tail without spending a page per lane", async () => {
    const read = source(), template = read.lanes[0]!;
    read.lanes = ["base", "optimism", "arbitrum", "bsc", "plasma"].map((chainId, i) => ({ ...template, id: `lane-${i}`,
      offRampAddress: addr(200 + i), destination: { ...template.destination, chainId, chainSelector: String(2 + i) } }));
    sent = read.lanes.map((lane, i) => ({
      ...send(1), address: lane.onRampAddress, topics: [SEND_16, word(2 + i), word(1)],
      data: encodeAbiParameters(parseAbiParameters(MESSAGE_16), [{
        header: { messageId: word(1000 + i), sourceChainSelector: 1n, destChainSelector: BigInt(2 + i), sequenceNumber: 1n, nonce: 0n },
        sender: addr(40), data: "0x", receiver: word(40), extraArgs: "0x", feeToken: addr(41), feeTokenAmount: 1n, feeValueJuels: 1n,
        tokenAmounts: [{ sourcePoolAddress: addr(11), destTokenAddress: word(20), extraData: "0x", amount: 10n, destExecData: "0x" }],
      }]), transactionHash: word(3000 + i), logIndex: `0x${i.toString(16)}`,
    }));
    pinNumber = 32105; finalized = 100000;
    let checkpoint: CcipPendingCheckpoint | undefined, accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      logRanges = [];
      const result = await observeCcipPending(input(read, checkpoint));
      expect(logRanges.length).toBeLessThanOrEqual(8);
      if (result.status === "accepted") {
        expect(result.amount).toBe("50");
        expect(result.proof.pins).toHaveLength(6);
        expect(result.proof.pins.every(pin => pin.anchor === pinNumber)).toBe(true);
        accepted = true; break;
      }
      expect(result.reason).toBe("history-incomplete");
      expect(result).not.toHaveProperty("amount");
      expect(result.checkpoint?.lanes).toHaveLength(5);
      checkpoint = result.checkpoint;
      pinNumber += 900;
    }
    expect(accepted).toBe(true);
  });
  it("rejects an old partial checkpoint and bootstraps the complete reviewed roster", async () => {
    const first = await observeCcipPending(input());
    if (first.status !== "accepted") throw new Error(first.reason);
    const old = { ...first.checkpoint, schemaVersion: 1 };
    delete (old as Partial<typeof old>).nextChainIndex;
    logRanges = [];
    const result = await observeCcipPending(input(source(), old as unknown as CcipPendingCheckpoint));
    expect(result).toMatchObject({ status: "accepted", amount: "10", checkpoint: { schemaVersion: 2 } });
    expect(logRanges).toEqual([{ chain: "ethereum", from: 100, to: 105 }]);
  });
  it("resumes complete history using the widest eligible declared endpoint span", async () => {
    pinNumber = 12105; sent = [send(1, 10n, 100), send(2, 20n, 12100)]; expectedNext = 3;
    const args = input();
    const endpoint = { url: "https://rpc.example", operator: "public" as const, keyed: false, position: "registry" as const, stateHistory: "archive" as const, logsHistory: "full" as const };
    args.chainRpcs.set("ethereum", { chainId: "ethereum", chainName: "ethereum", type: "evm", explorerUrl: "https://explorer.example",
      endpoints: [{ ...endpoint, maxLogBlockSpan: 1000 }, { ...endpoint, url: "https://fallback.example", maxLogBlockSpan: 1500 },
        { ...endpoint, url: "https://state.example", position: "supplemental", logsHistory: "none", maxLogBlockSpan: 1 }] });
    const first = await observeCcipPending(args);
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Missing bounded checkpoint");
    expect(first.checkpoint.lanes[0]!.sent.nextBlock).toBe(12100);
    expect(logRanges.every(range => range.to - range.from + 1 <= 1500)).toBe(true);
    expect(logRanges[0]).toEqual({ chain: "ethereum", from: 100, to: 1599 });
    logRanges = [];
    const resumed = { ...args, checkpoint: first.checkpoint };
    expect(await observeCcipPending(resumed)).toMatchObject({ status: "accepted", amount: "30" });
    expect(logRanges).toEqual([{ chain: "ethereum", from: 12100, to: 12105 }]);
  });
  it("uses a reviewed large endpoint span without the old 2,000-block ceiling", async () => {
    pinNumber = 2_000_105; finalized = pinNumber;
    const args = input();
    args.chainRpcs.set("ethereum", { chainId: "ethereum", chainName: "ethereum", type: "evm", explorerUrl: "https://explorer.example",
      endpoints: [{ url: "https://archive.example", operator: "alchemy", keyed: true, position: "registry",
        stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 2_000_000 }] });
    expect(await observeCcipPending(args)).toMatchObject({ status: "accepted", amount: "10" });
    expect(logRanges.filter(range => range.chain === "ethereum")).toEqual([
      { chain: "ethereum", from: 100, to: 2_000_099 },
      { chain: "ethereum", from: 2_000_100, to: 2_000_105 },
    ]);
  });
  it("subdivides unavailable wide pages without admitting an unproved prefix", async () => {
    pinNumber = 4105;
    const original = vi.mocked(fetchEvmRpcBatch).getMockImplementation()!;
    vi.mocked(fetchEvmRpcBatch).mockImplementation(async (chain, requests, options) => {
      const request = requests[0];
      if (request?.method === "eth_getLogs") {
        const filter = request.params[0] as { fromBlock: string; toBlock: string };
        if (Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock)) >= 2000) return null;
      }
      return original(chain, requests, options);
    });
    const args = input();
    args.chainRpcs.set("ethereum", { chainId: "ethereum", chainName: "ethereum", type: "evm", explorerUrl: "https://explorer.example",
      endpoints: [{ url: "https://archive.example", operator: "alchemy", keyed: true, position: "registry",
        stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 20_000 }] });
    expect(await observeCcipPending(args)).toMatchObject({ status: "accepted", amount: "10" });
    expect(logRanges.filter(range => range.chain === "ethereum")).toEqual([
      { chain: "ethereum", from: 100, to: 2099 },
      { chain: "ethereum", from: 2100, to: 4099 },
      { chain: "ethereum", from: 4100, to: 4105 },
    ]);
  });
  it("caps resumed execution pages independently of the source chain defaults", async () => {
    const first = await observeCcipPending(input());
    if (first.status !== "accepted") throw new Error(first.reason);
    pinNumber = 2106; states["1"] = 2; logRanges = [];
    const args = input(source(), first.checkpoint);
    args.chainRpcs.set("base", { chainId: "base", chainName: "base", type: "evm", explorerUrl: "https://explorer.example",
      endpoints: [{ url: "https://base.example", operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 500 }] });
    expect(await observeCcipPending(args)).toMatchObject({ status: "accepted", amount: "0" });
    expect(logRanges.filter(range => range.chain === "base")).toEqual([
      { chain: "base", from: 106, to: 605 }, { chain: "base", from: 606, to: 1105 },
      { chain: "base", from: 1106, to: 1605 }, { chain: "base", from: 1606, to: 2105 },
      { chain: "base", from: 2106, to: 2106 },
    ]);
    expect(logRanges.find(range => range.chain === "ethereum")).toEqual({ chain: "ethereum", from: 106, to: 2105 });
  });

  it("consumes a subsequent successful execution at the resumed finalized pin", async () => {
    const first = await observeCcipPending(input());
    if (first.status !== "accepted") throw new Error(first.reason);
    pinNumber = 106; states["1"] = 2;
    executed = [{ address: addr(31), topics: [EXECUTION_16, word(1), word(1), word(1001)],
      data: encodeAbiParameters(parseAbiParameters("bytes32,uint8,bytes,uint256"), [word(70), 2, "0x", 100n]),
      blockNumber: "0x6a", blockHash: word(106), transactionHash: word(80), logIndex: "0x1", removed: false }];
    expect(await observeCcipPending(input(source(), first.checkpoint))).toMatchObject({ status: "accepted", amount: "0" });
    expect(logRanges).toContainEqual({ chain: "base", from: 106, to: 106 });
  });
  it("rejects a checkpoint cursor whose predecessor hash changed", async () => {
    const first = await observeCcipPending(input());
    if (first.status !== "accepted") throw new Error(first.reason);
    first.checkpoint.lanes[0]!.sent.anchorHash = word(9999);
    expect(await observeCcipPending(input(source(), first.checkpoint))).toEqual({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("requires both holdings to bind the proof's exact finalized pins", async () => {
    const read = source(), result = await observeCcipPending(input(read));
    if (result.status !== "accepted") throw new Error(result.reason);
    const observation: EconomicSupplyObservation = { id: "in-flight:liability", deploymentKey: `ethereum:${addr(10)}`, amount: result.amount,
      observedAtSec: 1000, anchor: "105", anchorHash: word(105), responseSha256: result.responseSha256, ccipPendingProof: result.proof };
    const deployments = [{ chainId: "ethereum", deploymentKey: `ethereum:${addr(10)}` }, { chainId: "base", deploymentKey: `base:${addr(20)}` }];
    const holdings = deployments.map(row => ({ ...observation, id: row.deploymentKey, deploymentKey: row.deploymentKey }));
    expect(authenticateCcipPendingObservation(read, observation, holdings, deployments)).toBe(true);
    holdings[1]!.anchorHash = word(106);
    expect(authenticateCcipPendingObservation(read, observation, holdings, deployments)).toBe(false);
    observation.amount = "20";
    observation.responseSha256 = sha256Hex(stableJsonStringifyV1({ proof: result.proof, amount: "20" }));
    expect(authenticateCcipPendingObservation(read, observation, deployments.map(row => ({ ...observation, id: row.deploymentKey })), deployments)).toBe(false);
  });
  it("decodes v1.5 sends and retains failed token-pool liabilities", async () => {
    sent = [send(1, 12n, 100, "1.5")]; states["1"] = 3;
    expect(await observeCcipPending(input(source("1.5")))).toMatchObject({ status: "accepted", amount: "12", proof: { lanes: [{ pendingCount: 1, failedCount: 1 }] } });
  });
  it("decodes v2.0 packed MessageV1 and keeps the post-fee amount owed", async () => {
    sent = [send20(1, 9n)]; indexed = [sent[0]!.topics[3]!];
    states[sent[0]!.topics[3]!] = 3;
    expect(await observeCcipPending(input(source("2.0.0")))).toMatchObject({ status: "accepted", amount: "9", proof: { lanes: [{ failedCount: 1, lastSequence: "1" }] } });
  });
  it("excludes v2.0 SUCCESS by message ID and consumes subsequent execution logs", async () => {
    sent = [send20(1)];
    const read = source("2.0.0"), first = await observeCcipPending(input(read));
    if (first.status !== "accepted") throw new Error(first.reason);
    pinNumber = 106; states[sent[0]!.topics[3]!] = 2;
    executed = [{ address: addr(31), topics: [EXECUTION_20, word(1), word(1), sent[0]!.topics[3]!],
      data: encodeAbiParameters(parseAbiParameters("uint8,bytes"), [2, "0x"]),
      blockNumber: "0x6a", blockHash: word(106), transactionHash: word(80), logIndex: "0x1", removed: false }];
    expect(await observeCcipPending(input(read, first.checkpoint))).toMatchObject({ status: "accepted", amount: "0" });
  });
  it("rejects a v2.0 message whose keccak ID or packed identity does not match the event", async () => {
    const log = send20(1); log.topics[3] = word(555); sent = [log];
    expect(await observeCcipPending(input(source("2.0.0")))).toEqual({ status: "rejected", reason: "message-codec-identity" });
  });
  it("rejects an unknown lane version rather than guessing an ABI", () => {
    const read = source();
    expect(CcipPendingReadSchema.safeParse({ ...read, lanes: [{ ...read.lanes[0], version: "2.1.0" }] }).success).toBe(false);
  });
  it("accounts for migrated v1.6 and v2.0 histories independently", async () => {
    const read = source(), next = { ...source("2.0.0").lanes[0]!, id: "eth-base-v20", onRampAddress: addr(32), offRampAddress: addr(33) };
    read.lanes.push(next); sent = [send(1, 10n), { ...send20(1, 7n, 100, 32, 33), logIndex: "0x2" }];
    expect(await observeCcipPending(input(read))).toMatchObject({ status: "accepted", amount: "17", proof: { lanes: [{ amount: "10" }, { amount: "7" }] } });
  });
  it("deducts lock/mint escrow once while preserving proved pending as visible remainder", async () => {
    sent = [send(1, 1000000n)];
    const read = source(), result = await observeCcipPending(input(read));
    if (result.status !== "accepted") throw new Error(result.reason);
    const pending: EconomicSupplyObservation = { id: "in-flight:bridge-escrow", deploymentKey: `ethereum:${addr(10)}`, amount: result.amount,
      observedAtSec: 1000, anchor: "105", anchorHash: word(105), responseSha256: result.responseSha256, ccipPendingProof: result.proof };
    const capture = economicInput(read, pending), packet = deriveReviewedEconomicDeploymentPartition(capture);
    expect(packet?.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(packet?.aggregate.supplyUsd).toBe(100); expect(packet?.unattributedSupplyUsd).toBe(1);
    delete pending.ccipPendingProof;
    expect(deriveReviewedEconomicDeploymentPartition(capture)).toBeNull();
  });
  it("keeps independently burned in-flight liability in the denominator without manufacturing deployment shares", async () => {
    sent = [send20(1, 1000000n)];
    const read = source("2.0.0"), result = await observeCcipPending(input(read));
    if (result.status !== "accepted") throw new Error(result.reason);
    const pending: EconomicSupplyObservation = { id: "in-flight:liability", deploymentKey: `ethereum:${addr(10)}`, amount: result.amount,
      observedAtSec: 1000, anchor: "105", anchorHash: word(105), responseSha256: result.responseSha256, ccipPendingProof: result.proof };
    const capture = economicInput(read, pending);
    capture.plan.escrows = []; capture.plan.accountingFamily = "independent-liability"; capture.plan.liabilityInFlightSource = read;
    capture.observations.pop(); capture.observations[0]!.amount = "80000000";
    expect(deriveReviewedEconomicDeploymentPartition(capture)).toBeNull();
    for (const route of capture.meta.bridgeRouteRisk?.routes ?? []) route.semantics = "burn-mint";
    const packet = deriveReviewedEconomicDeploymentPartition(capture);
    expect(packet?.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(packet?.unattributedSupplyUsd).toBe(1);
    pending.anchorHash = word(106);
    expect(deriveReviewedEconomicDeploymentPartition(capture)).toBeNull();
  });
  it("does not interpret a removed current pool peer as zero pending", async () => {
    peersRemoved = true;
    expect(await observeCcipPending(input())).toEqual({ status: "rejected", reason: "pool-peer-mismatch" });
  });
  it("uses reviewed historical peer identity without freezing current owed quantities", async () => {
    peersRemoved = true; states["1"] = 3;
    const read = source();
    read.lanes[0]!.source.peerBindingPin = { number: 102, hash: word(102) };
    read.lanes[0]!.destination.peerBindingPin = { number: 102, hash: word(102) };
    expect(await observeCcipPending(input(read))).toMatchObject({ status: "accepted", amount: "10", proof: { lanes: [{ failedCount: 1 }] } });
    read.lanes[0]!.source.peerBindingPin.hash = word(103);
    expect(await observeCcipPending(input(read))).toEqual({ status: "rejected", reason: "peer-binding-pin-invalid" });
  });
});
