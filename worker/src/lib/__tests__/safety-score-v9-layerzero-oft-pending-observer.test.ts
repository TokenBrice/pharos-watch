import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ReviewedEconomicSupplyPlanSchema, type LayerZeroOftPendingRead, type ReviewedEconomicSupplyPlan, type EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import type { StablecoinMeta } from "@shared/types/core";
import type { ChainRpcConfig } from "../chain-registry";
import { USER_AGENT } from "../constants";
import * as evmRpc from "../evm-rpc";
import { observeLayerZeroOftPending } from "../safety-score-v9/layerzero-oft-pending-observer";
import { deriveReviewedEconomicDeploymentPartition } from "../safety-score-v9/supply-attribution-contract";

const CLOCK = 1791184659;
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const address = (value: number): `0x${string}` => `0x${value.toString(16).padStart(40, "0")}`;
const addressWord = (value: string): `0x${string}` => `0x${value.slice(2).padStart(64, "0")}`;
const topic = (signature: string) => keccak256(toHex(signature));
const header = (number: number) => ({ number, hash: word(BigInt(number)), timestamp: CLOCK - 600 + number });
const SENT = topic("PacketSent(bytes,bytes,address)");
const DELIVERED = topic("PacketDelivered((uint32,bytes32,uint64),address)");
const CREDITED = topic("OFTReceived(bytes32,uint32,address,uint256)");
const DEBITED = topic("OFTSent(bytes32,uint32,address,uint256,uint256)");

type FixtureLog = {
  address: string; topics: string[]; data: `0x${string}`; transactionHash: string;
  blockNumber: string; blockHash: `0x${string}`; logIndex: string; removed: boolean;
};
type FixtureReceipt = {
  status: string; transactionHash: `0x${string}`; blockNumber: string; blockHash: `0x${string}`; logs: FixtureLog[];
};
type Send = { nonce: bigint; amountSD: bigint; state: "unverified" | "stored" | "delivered"; height?: number };
function fixture(sends: Send[] = [{ nonce: 1n, amountSD: 1234567n, state: "unverified" }]) {
  const side = (chainId: string, eid: number, value: number) => ({ chainId, eid, oappAddress: address(value), tokenAddress: address(value),
    oappRuntimeCodeSha256: sha256Hex("0x6000"), endpointAddress: address(value + 10), endpointRuntimeCodeSha256: sha256Hex("0x6000"),
    localDecimals: 18, deploymentBlock: 100 });
  const source: LayerZeroOftPendingRead = { kind: "evm-layerzero-oft-pending", sourceId: "oft", chainId: "ethereum", finality: "finalized",
    sharedDecimals: 6, localDecimals: 18, sides: [side("ethereum", 30101, 1), side("base", 30184, 2)], pathways: [{ sourceIndex: 0, destinationIndex: 1 }] };
  const [a, b] = source.sides;
  let pin = 100, finalized = 100;
  const messages = sends.map((send, index) => {
    const packed = `${send.nonce.toString(16).padStart(16, "0")}${a!.eid.toString(16).padStart(8, "0")}${addressWord(a!.oappAddress).slice(2)}${b!.eid.toString(16).padStart(8, "0")}${addressWord(b!.oappAddress).slice(2)}`;
    const guid = keccak256(`0x${packed}`);
    const recipient = address(100 + index), txHash = word(BigInt(1000 + index)), destinationTxHash = word(BigInt(2000 + index));
    const payload: `0x${string}` = `0x${addressWord(recipient).slice(2)}${send.amountSD.toString(16).padStart(16, "0")}`;
    const packet: `0x${string}` = `0x01${send.nonce.toString(16).padStart(16, "0")}${a!.eid.toString(16).padStart(8, "0")}${addressWord(a!.oappAddress).slice(2)}${b!.eid.toString(16).padStart(8, "0")}${addressWord(b!.oappAddress).slice(2)}${guid.slice(2)}${payload.slice(2)}`;
    return { ...send, recipient, guid, payload, packet, txHash, destinationTxHash, height: send.height ?? 100 };
  });
  const discoveries = messages.map(message => ({ guid: message.guid, pathway: { srcEid: a!.eid, dstEid: b!.eid, sender: { address: a!.oappAddress }, receiver: { address: b!.oappAddress } },
    source: { tx: { txHash: message.txHash, blockNumber: String(message.height) } },
    destination: message.state === "delivered" ? { tx: { txHash: message.destinationTxHash } } : {} }));
  const log = (to: string, topics: string[], data: `0x${string}`, hash: string, height: number): FixtureLog => ({ address: to, topics, data, transactionHash: hash,
    blockNumber: `0x${height.toString(16)}`, blockHash: header(height).hash, logIndex: "0x0", removed: false });
  const receipts = new Map<string, FixtureReceipt>(messages.flatMap(message => {
    const amount = message.amountSD * 10n ** 12n;
    const sourceReceipt = { status: "0x1", transactionHash: message.txHash, blockNumber: `0x${message.height.toString(16)}`, blockHash: header(message.height).hash, logs: [
      log(a!.endpointAddress, [SENT], encodeAbiParameters(parseAbiParameters("bytes,bytes,address"), [message.packet, "0x", address(50)]), message.txHash, message.height),
      log(a!.oappAddress, [DEBITED, message.guid, addressWord(address(50))], encodeAbiParameters(parseAbiParameters("uint32,uint256,uint256"), [b!.eid, amount, amount]), message.txHash, message.height),
    ] };
    const destinationReceipt = { status: "0x1", transactionHash: message.destinationTxHash, blockNumber: "0x64", blockHash: header(100).hash, logs: [
      log(b!.endpointAddress, [DELIVERED], encodeAbiParameters(parseAbiParameters("(uint32,bytes32,uint64),address"), [[a!.eid, addressWord(a!.oappAddress), message.nonce], b!.oappAddress as `0x${string}`]), message.destinationTxHash, 100),
      log(b!.oappAddress, [CREDITED, message.guid, addressWord(message.recipient)], encodeAbiParameters(parseAbiParameters("uint32,uint256"), [a!.eid, amount]), message.destinationTxHash, 100),
    ] };
    return [[message.txHash, sourceReceipt], [message.destinationTxHash, destinationReceipt]] as const;
  }));
  let outbound = messages.reduce((max, message) => message.nonce > max ? message.nonce : max, 0n);
  let lazy = messages.filter(message => message.state === "delivered").reduce((max, message) => message.nonce > max ? message.nonce : max, 0n);
  let inbound = messages.filter(message => message.state !== "unverified").reduce((max, message) => message.nonce > max ? message.nonce : max, lazy);
  const batch = vi.spyOn(evmRpc, "fetchEvmRpcBatch").mockImplementation(async (chain, calls) => calls.map(request => {
    if (request.method === "eth_getCode") return "0x6000";
    if (request.method === "eth_getTransactionReceipt") return receipts.get(String(request.params[0])) ?? null;
    if (request.method !== "eth_call") throw new Error("Unexpected RPC");
    const query = request.params[0] as { to: string; data: string }, block = request.params[1] as { blockHash: string };
    const which = chain === "ethereum" ? a! : b!, remote = chain === "ethereum" ? b! : a!;
    const selector = query.data.slice(0, 10);
    if (selector === toFunctionSelector("endpoint()")) return addressWord(which.endpointAddress);
    if (selector === toFunctionSelector("eid()")) return word(BigInt(which.eid));
    if (selector === toFunctionSelector("token()")) return addressWord(which.tokenAddress);
    if (selector === toFunctionSelector("decimals()")) return word(BigInt(which.localDecimals));
    if (selector === toFunctionSelector("sharedDecimals()")) return word(6n);
    if (selector === toFunctionSelector("decimalConversionRate()")) return word(10n ** BigInt(which.localDecimals - 6));
    if (selector === toFunctionSelector("peers(uint32)")) return addressWord(remote.oappAddress);
    if (selector === toFunctionSelector("outboundNonce(address,uint32,bytes32)")) return word(block.blockHash === header(99).hash ? 0n : outbound);
    if (selector === toFunctionSelector("inboundNonce(address,uint32,bytes32)")) return word(inbound);
    if (selector === toFunctionSelector("lazyInboundNonce(address,uint32,bytes32)")) return word(lazy);
    if (selector === toFunctionSelector("inboundPayloadHash(address,uint32,bytes32,uint64)")) {
      const nonce = BigInt(`0x${query.data.slice(-64)}`), message = messages.find(row => row.nonce === nonce);
      return message?.state === "stored" ? keccak256(`0x${message.guid.slice(2)}${message.payload.slice(2)}`) : word(0n);
    }
    throw new Error("Unexpected state read");
  }));
  const headers = vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (_chain, number) => header(number === "finalized" ? finalized : number));
  const fetcher = vi.fn<typeof fetch>(async (raw) => {
    const url = new URL(String(raw));
    return new Response(JSON.stringify({ data: url.pathname.includes("/guid/") ? discoveries.filter(row => url.pathname.endsWith(row.guid)) : discoveries }));
  });
  vi.stubGlobal("fetch", fetcher);
  return { source, messages, discoveries, receipts, batch, headers, fetcher,
    setPin(value: number) { pin = value; finalized = value; }, setFinalized(value: number) { finalized = value; },
    setNonces(values: { outbound?: bigint; inbound?: bigint; lazy?: bigint }) { outbound = values.outbound ?? outbound; inbound = values.inbound ?? inbound; lazy = values.lazy ?? lazy; },
    run(checkpoint?: Parameters<typeof observeLayerZeroOftPending>[0]["checkpoint"]) { return observeLayerZeroOftPending({ source, headers: [header(pin), header(pin)], chainRpcs: new Map<string, ChainRpcConfig>(), checkpoint }); },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("authenticated LayerZero V2 OFT pending census", () => {
  it("converts shared decimals exactly beyond Number precision and supports adapter token identity", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 2n ** 64n - 1n, state: "unverified" }]);
    f.source.sides[0]!.tokenAddress = address(999);
    expect(await f.run()).toMatchObject({ status: "accepted", amount: ((2n ** 64n - 1n) * 10n ** 12n).toString(),
      proof: { pathways: [expect.objectContaining({ sentNonce: "1", pendingCount: 1 })] } });
  });
  it("excludes only destination receipts with endpoint delivery and matching OApp credit", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 3n, state: "delivered" }, { nonce: 2n, amountSD: 7n, state: "unverified" }]);
    expect(await f.run()).toMatchObject({ status: "accepted", amount: "7000000000000", checkpoint: { pathways: [expect.objectContaining({ messages: [expect.objectContaining({ nonce: "2" })] })] } });
  });
  it("keeps a stored payload pending despite indexer delivery status and advanced inbound nonce", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 4n, state: "stored" }]);
    Object.assign(f.discoveries[0]!, { destination: { status: "SUCCEEDED", tx: { txHash: word(2000n) } } });
    expect(await f.run()).toMatchObject({ status: "accepted", amount: "4000000000000", proof: { pathways: [expect.objectContaining({ inboundNonce: "1", lazyInboundNonce: "0", pendingCount: 1 })] } });
  });
  it("keeps failed lzReceive retry liability pending when the endpoint still commits its payload", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 3n, state: "stored" }]);
    Object.assign(f.discoveries[0]!, { destination: { status: "FAILED", tx: { txHash: f.messages[0]!.destinationTxHash } } });
    const receipt = f.receipts.get(f.messages[0]!.destinationTxHash)!;
    receipt.status = "0x0"; receipt.logs.length = 0;
    expect(await f.run()).toMatchObject({ status: "accepted", amount: "3000000000000" });
  });
  it("handles unordered delivery with an older stored payload below lazyInboundNonce", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 4n, state: "stored" }, { nonce: 2n, amountSD: 7n, state: "delivered" }]);
    expect(await f.run()).toMatchObject({ status: "accepted", amount: "4000000000000" });
  });
  it("rejects a nonce gap instead of publishing a partial pending set", async () => {
    expect(await fixture([{ nonce: 1n, amountSD: 1n, state: "unverified" }, { nonce: 3n, amountSD: 1n, state: "unverified" }]).run()).toEqual({ status: "rejected", reason: "missing-nonce" });
  });
  it("rejects indexer-only sends without an EndpointV2 PacketSent proof", async () => {
    const f = fixture(); f.receipts.get(f.messages[0]!.txHash)!.logs.splice(0, 1);
    expect(await f.run()).toEqual({ status: "rejected", reason: "source-send-unproved" });
  });
  it("rejects an indexer omission through the pinned outbound nonce", async () => {
    const f = fixture(); f.discoveries.splice(0);
    expect(await f.run()).toEqual({ status: "rejected", reason: "send-census-mismatch" });
  });
  it("rejects an unfinalized holding pin", async () => {
    const f = fixture(); f.setFinalized(99);
    expect(await f.run()).toEqual({ status: "rejected", reason: "pin-not-finalized" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("preserves nonce continuity for a genuine zero-amount OFT packet", async () => {
    expect(await fixture([{ nonce: 1n, amountSD: 0n, state: "unverified" }]).run()).toMatchObject({
      status: "accepted", amount: "0", proof: { pathways: [expect.objectContaining({ sentNonce: "1", pendingCount: 1 })] },
    });
  });
  it.each(["application credit", "endpoint delivery", "receipt success"])("rejects delivery missing %s", async failure => {
    const f = fixture([{ nonce: 1n, amountSD: 3n, state: "delivered" }]);
    const delivered = f.receipts.get(f.messages[0]!.destinationTxHash)!;
    if (failure === "receipt success") delivered.status = "0x0";
    else delivered.logs.splice(failure === "application credit" ? 1 : 0, 1);
    expect(await f.run()).toMatchObject({ status: "rejected", reason: failure === "application credit" ? "lzreceive-unproved" : failure === "endpoint delivery" ? "delivery-unproved" : "receipt-unproved" });
  });
  it("rejects skipped/cleared messages instead of treating lazy nonce as successful credit", async () => {
    const f = fixture(); f.setNonces({ inbound: 1n, lazy: 1n });
    expect(await f.run()).toEqual({ status: "rejected", reason: "delivery-unproved" });
  });
  it("rejects a history floor after earlier sends", async () => {
    const f = fixture(), original = f.batch.getMockImplementation()!;
    f.batch.mockImplementation(async (chain, requests, options) => {
      const block = requests[0]?.params[1];
      if (chain === "ethereum" && requests[0]?.method === "eth_call" &&
        block && typeof block === "object" && "blockHash" in block && block.blockHash === header(99).hash) return [word(1n)];
      return original(chain, requests, options);
    });
    expect(await f.run()).toEqual({ status: "rejected", reason: "history-start-unproved" });
  });
  it("resumes bounded inclusive pages and reauthenticates the predecessor", async () => {
    const f = fixture([{ nonce: 1n, amountSD: 0n, state: "unverified", height: 16900 }]); f.setPin(17000);
    const first = await f.run();
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete", checkpoint: { pathways: [expect.objectContaining({ sent: expect.objectContaining({ nextBlock: 16100 }) })] } });
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Expected resumable checkpoint");
    expect(await f.run(first.checkpoint)).toMatchObject({ status: "accepted", amount: "0" });
    expect(f.headers).toHaveBeenCalledWith("ethereum", 16099, expect.anything());
    first.checkpoint.pathways[0]!.sent.anchorHash = word(999n);
    expect(await f.run(first.checkpoint)).toEqual({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("refreshes checkpoint messages when they complete without rescanning source history", async () => {
    const f = fixture(); const first = await f.run();
    if (first.status !== "accepted") throw new Error("Expected accepted source census");
    f.messages[0]!.state = "delivered"; f.discoveries[0]!.destination = { tx: { txHash: f.messages[0]!.destinationTxHash } };
    f.setNonces({ inbound: 1n, lazy: 1n });
    expect(await f.run(first.checkpoint)).toMatchObject({ status: "accepted", amount: "0" });
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/pathway/"))).toHaveLength(1);
  });
  it("identifies both pathway and GUID discovery requests to Scan's Worker-egress filter", async () => {
    const f = fixture(), original = f.fetcher.getMockImplementation()!;
    // Pinned remote-preview behavior: the same Scan URL returns 403 without
    // a User-Agent (even with Accept alone), and 200 with the Pharos agent.
    f.fetcher.mockImplementation(async (raw, init) => {
      if (new Headers(init?.headers).get("User-Agent") !== USER_AGENT) return new Response("Forbidden", { status: 403 });
      return original(raw, init);
    });
    const first = await f.run();
    expect(first).toMatchObject({ status: "accepted", amount: "1234567000000000000" });
    if (first.status !== "accepted") throw new Error("Expected authenticated source census");
    f.discoveries[0]!.destination = { tx: { txHash: f.messages[0]!.destinationTxHash } };
    f.setNonces({ inbound: 1n, lazy: 1n });
    expect(await f.run(first.checkpoint)).toMatchObject({ status: "accepted", amount: "0" });
    expect(f.fetcher.mock.calls.map(([raw]) => new URL(String(raw)).pathname)).toEqual([
      expect.stringContaining("/messages/pathway/"), `/v1/messages/guid/${f.messages[0]!.guid}`,
    ]);
    for (const [, init] of f.fetcher.mock.calls) expect(new Headers(init?.headers).get("User-Agent")).toBe(USER_AGENT);
  });
  it.each([403, 429])("rejects Scan HTTP %s instead of publishing zero or advancing history", async status => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("Discovery unavailable", { status }));
    expect(await f.run()).toEqual({ status: "rejected", reason: "discovery-unavailable" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a receipt on a changed canonical block", async () => {
    const f = fixture(); f.receipts.get(f.messages[0]!.txHash)!.blockHash = word(999n);
    expect(await f.run()).toEqual({ status: "rejected", reason: "receipt-anchor" });
  });
  it("rejects replaying a checkpoint against an older destination pin", async () => {
    const f = fixture([]); const first = await f.run();
    if (first.status !== "accepted") throw new Error("Expected accepted census");
    first.checkpoint.pathways[0]!.destinationAnchor = 101;
    expect(await f.run(first.checkpoint)).toEqual({ status: "rejected", reason: "checkpoint-reorg" });
  });
  it("proves unused history from the actual zero outbound nonce without indexer assumptions", async () => {
    const f = fixture([]); f.setPin(17000);
    expect(await f.run()).toMatchObject({ status: "accepted", amount: "0" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects a checkpoint whose cached amount no longer matches its authenticated OFT payload", async () => {
    const f = fixture(); const first = await f.run();
    if (first.status !== "accepted") throw new Error("Expected authenticated checkpoint");
    first.checkpoint.pathways[0]!.messages[0]!.amountSD = "99";
    expect(await f.run(first.checkpoint)).toEqual({ status: "rejected", reason: "checkpoint-message" });
  });
  it("rejects unresolved messages exceeding the aggregate checkpoint capacity across lanes", async () => {
    const f = fixture(); const first = await f.run();
    if (first.status !== "accepted") throw new Error("Expected authenticated checkpoint");
    const lane = first.checkpoint.pathways[0]!, message = lane.messages[0]!;
    f.source.pathways.push({ sourceIndex: 1, destinationIndex: 0 });
    first.checkpoint.sourceDigest = sha256Hex(stableJsonStringifyV1(f.source));
    first.checkpoint.pathways = [{ ...lane, messages: Array(512).fill(message) }, { ...lane, messages: [message] }];
    expect(await f.run(first.checkpoint)).toEqual({ status: "rejected", reason: "checkpoint-capacity" });
  });
  it("propagates cancellation", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(observeLayerZeroOftPending({ source: f.source, headers: [header(100), header(100)], chainRpcs: new Map(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["independent-liability", "lock-mint"])("admits %s pending only with every holding-bound OFT proof pin", async family => {
    const f = fixture(); f.source.sides[0]!.tokenAddress = address(777);
    const read = await f.run();
    if (read.status !== "accepted") throw new Error("Expected authenticated census");
    const plan: ReviewedEconomicSupplyPlan = {
      assetId: "oft-alpha", reviewer: "reviewer", reviewedAtSec: CLOCK - 86400, expiresAtSec: CLOCK + 86400,
      evidenceUrls: ["https://issuer.example/oft"], economicScope: "All token claims", sourceId: "reference", accountingFamily: family,
      commonClaimUnit: "shares", exhaustive: true, inFlightTreatment: "observed-reconciled", conversionSources: [], referencePriceSource: null,
      liabilityInFlightSource: family === "independent-liability" ? f.source : null, excludedRegistryDeploymentKeys: [], exclusions: [],
      escrows: family === "lock-mint" ? [{ id: "oft", canonicalDeploymentKey: `ethereum:${address(777)}`, account: f.source.sides[0]!.oappAddress,
        receiptDeploymentKeys: [`base:${f.source.sides[1]!.tokenAddress}`], independentReceiptLiability: false,
        receiptClaimSources: [], inFlightSource: f.source }] : [],
      deployments: f.source.sides.map(side => ({ deploymentKey: `${side.chainId}:${side.tokenAddress}`, chainId: side.chainId, address: side.tokenAddress,
        holdingKind: "contract", amountBasis: "fixed-token-units", decimals: side.localDecimals, routeId: null,
        read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "shares", conversionSourceId: null })),
    };
    const observations: EconomicSupplyObservation[] = plan.deployments.map((row, index) => ({ id: row.deploymentKey, deploymentKey: row.deploymentKey,
      amount: family === "lock-mint" && index === 0 ? "3234567000000000000" : "1000000000000000000",
      observedAtSec: header(100).timestamp, anchor: "100", anchorHash: header(100).hash, responseSha256: sha256Hex("supply") }));
    if (family === "lock-mint") observations.push({ ...observations[0]!, id: "oft", amount: "2234567000000000000" });
    const pending: EconomicSupplyObservation = { id: family === "lock-mint" ? "in-flight:oft" : "in-flight:liability",
      deploymentKey: plan.deployments[0]!.deploymentKey, amount: read.amount, observedAtSec: header(100).timestamp,
      anchor: "100", anchorHash: header(100).hash, responseSha256: read.responseSha256, layerZeroOftPendingProof: read.proof };
    const meta = { contracts: f.source.sides.map(side => ({ chain: side.chainId, address: side.tokenAddress, decimals: side.localDecimals })) } as StablecoinMeta;
    const derive = () => deriveReviewedEconomicDeploymentPartition({ plan, meta, baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "b".repeat(64), clockSec: CLOCK,
      aggregate: { sourceGeneration: "source", observedAtSec: header(100).timestamp, supplyUsd: 3.234567 },
      referencePrice: { sourceId: "reference", sourceGeneration: "source", observedAtSec: header(100).timestamp, value: "1", responseSha256: sha256Hex("reference") },
      conversions: [], observations, inFlight: [pending] });
    expect(derive()).toMatchObject({ quantitativeCompleteness: true, unattributedSupplyUsd: 1.234567 });
    const differentCanonical = { ...plan.deployments[0]!, deploymentKey: `ethereum:${address(888)}`, address: address(888) };
    plan.deployments.unshift(differentCanonical);
    const escrow = plan.escrows[0];
    if (escrow) escrow.canonicalDeploymentKey = differentCanonical.deploymentKey;
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(plan).success).toBe(false);
    plan.deployments.shift();
    if (escrow) escrow.canonicalDeploymentKey = plan.deployments[0]!.deploymentKey;
    const original = read.proof.pins[1]!.anchorHash;
    read.proof.pins[1]!.anchorHash = word(999n);
    pending.responseSha256 = sha256Hex(stableJsonStringifyV1({ proof: read.proof, amount: pending.amount }));
    expect(derive()).toBeNull();
    read.proof.pins[1]!.anchorHash = original;
    read.proof.pathways[0]!.pendingAmountSD = "1";
    pending.responseSha256 = sha256Hex(stableJsonStringifyV1({ proof: read.proof, amount: pending.amount }));
    expect(derive()).toBeNull();
  });
});
