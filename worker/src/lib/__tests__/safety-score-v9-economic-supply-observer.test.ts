import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sha256Hex } from "@shared/lib/sha256";
import type { StablecoinMeta } from "@shared/types/core";
import { ReviewedEconomicSupplyPlanSchema, type CcipPendingRead, type CurveLzPendingRead, type LayerZeroOftPendingRead, type ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import * as evmRpc from "../evm-rpc";
import type { ChainRpcConfig } from "../chain-registry";
import { observeCurveLzPending, observeEconomicSolanaMint, observeReviewedEconomicDeploymentPartitionAttempt } from "../safety-score-v9/economic-supply-observer";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, reviewedEconomicDeploymentAttributionValidationError } from "../safety-score-v9/supply-attribution-contract";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = 1790850000;
const HASH: `0x${string}` = `0x${"a".repeat(64)}`;
const OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "So11111111111111111111111111111111111111112";
const apiSource = (sourceId: string) => ({ sourceId, url: `https://issuer.example/${sourceId}`, amountPath: ["data", "amount"], observedAtPath: ["data", "observedAt"], generationPath: ["data", "generation"] });
const apiBody = (amount: unknown = "1", observedAt: unknown = CLOCK - 60) => ({ data: { amount, observedAt, generation: "issuer-snapshot" } });
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const account = (supply = "100000000") => ({ context: { slot: 100 }, value: { owner: OWNER, data: { parsed: { type: "mint", info: { supply, decimals: 6 } } } } });

function fixture() {
  const address = `0x${"1".repeat(40)}`;
  const plan: ReviewedEconomicSupplyPlan = {
    assetId: "alpha", reviewer: "reviewer", reviewedAtSec: CLOCK - 86400, expiresAtSec: CLOCK + 86400,
    evidenceUrls: ["https://issuer.example/accounting"], economicScope: "All circulating holder claims",
    sourceId: "reference", accountingFamily: "independent-liability", commonClaimUnit: "claim", exhaustive: true, inFlightTreatment: "observed-reconciled",
    deployments: [{ deploymentKey: `ethereum:${address}`, chainId: "ethereum", address, holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: null, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null }],
    excludedRegistryDeploymentKeys: [], exclusions: [], escrows: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
  };
  const fixedInput = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
  Object.assign(fixedInput, {
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "d".repeat(64),
    aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } },
    chainCirculatingById: {}, navPriceById: { alpha: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } },
  });
  vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockImplementation(id => id === "alpha" ? plan : undefined);
  vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => id === "alpha" ? {
    contracts: plan.deployments.filter(row => row.holdingKind !== "native-gas").map(row => ({ chain: row.chainId, address: row.address!, decimals: row.decimals })),
  } as StablecoinMeta : undefined);
  const chainRpcs = new Map<string, ChainRpcConfig>();
  return { plan, fixedInput, assetId: "alpha", chainRpcs, scoringClockSec: CLOCK, run(signal?: AbortSignal, scoringClockSec = CLOCK) { return observeReviewedEconomicDeploymentPartitionAttempt({ assetId: "alpha", fixedInput, chainRpcs, signal, scoringClockSec }); } };
}

beforeEach(() => {
  vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockResolvedValue(102);
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - 60, hash: HASH }));
  vi.spyOn(evmRpc, "fetchEvmMulticall3Aggregate3AtBlock").mockImplementation(async (_chain, calls) => calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n : 100000000n) })));
  vi.spyOn(evmRpc, "fetchEvmRpcBatch").mockResolvedValue(["0xde0b6b3a7640000"]);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reviewed economic supply observation", () => {
  it("admits a pinned EVM supply with its rechecked block identity and conserved allocation", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.observations).toEqual([expect.objectContaining({ deploymentKey: f.plan.deployments[0]!.deploymentKey, amount: "100000000", anchor: "100", anchorHash: HASH, observedAtSec: CLOCK - 60 })]);
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBe(100);
    expect(result.attribution.unattributedSupplyUsd).toBe(0);
  });

  it("batches same-chain supplies and balance exclusions at one pin without mixing amounts", async () => {
    const f = fixture();
    const first = f.plan.deployments[0]!;
    const second = { ...first, deploymentKey: `ethereum:0x${"2".repeat(40)}`, address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(second);
    f.plan.exclusions = [{ id: "treasury", deploymentKey: second.deploymentKey, account: `0x${"3".repeat(40)}` }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(
        call.label.endsWith(":decimals") ? 6n : call.label === first.deploymentKey ? 100000000n :
          call.label === "treasury" ? 100000000n : 1000000000n,
      ) })),
    );
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted batch partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([10, 90]);
    expect(result.attribution.observations.map(row => row.amount)).toEqual(["100000000", "1000000000", "100000000"]);
    expect(new Set(result.attribution.observations.map(row => row.anchorHash))).toEqual(new Set([HASH]));
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][1]).toHaveLength(6);
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3])
      .toMatchObject({ stateBlockHash: HASH, multicallFallbackBlockHash: HASH });
  });

  it("rejects the exact failed batch leaf, never treating its unavailable amount as zero", async () => {
    const f = fixture();
    const first = f.plan.deployments[0]!;
    const second = { ...first, deploymentKey: `ethereum:0x${"2".repeat(40)}`, address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(second);
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: call.label !== second.deploymentKey,
        returnData: word(call.label.endsWith(":decimals") ? 6n : 100000000n) })),
    );
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: second.deploymentKey,
    });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(1);
  });

  it("admits pre-capture state newer than the previous source clock without redating its source", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK + 599, hash: HASH }));
    const result = await f.run(undefined, CLOCK + 600);
    expect(result).toMatchObject({ status: "accepted", attribution: {
      baseInputGenerationId: f.fixedInput.baseInputGenerationId, sourceGeneration: "source",
      scoringClockSec: CLOCK + 600, aggregate: { observedAtSec: CLOCK - 60, sourceGeneration: "source" },
      observations: [expect.objectContaining({ observedAtSec: CLOCK + 599, anchorHash: HASH })],
    } });
  });

  it.each([CLOCK - 1, NaN, CLOCK + 0.5])("rejects an inadmissible capture clock %s", async scoringClockSec => {
    const f = fixture();
    expect(await f.run(undefined, scoringClockSec)).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it("fails closed when a reviewed deployment observer throws", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockRejectedValue(new Error("RPC unavailable"));
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: f.plan.deployments[0]!.deploymentKey });
  });

  it.each(["hash", "timestamp", "missing"])("rejects a changed %s on the pinned block recheck", async change => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH }).mockResolvedValueOnce(change === "missing" ? null : { number: 100, timestamp: CLOCK - (change === "timestamp" ? 61 : 60), hash: change === "hash" ? `0x${"b".repeat(64)}` : HASH });
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-invalid", failedRouteId: "anchor:ethereum" });
  });

  it.each(["malformed", "oversized", "wrong decimals", "failed call"])("fails closed on %s EVM results", async failure => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockResolvedValue([{ label: "supply", success: failure !== "failed call", returnData: failure === "malformed" ? "0xzz" : failure === "oversized" ? `0x${"1".repeat(66)}` : word(100000000n) }, { label: "decimals", success: true, returnData: word(failure === "wrong decimals" ? 18n : 6n) }]);
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: f.plan.deployments[0]!.deploymentKey });
  });

  it("rejects unavailable safe heads, missing aggregate clocks and unreviewed assets", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(1);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
    f.fixedInput.aggregateCirculatingById.alpha!.observedAtSec = null;
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null });
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, assetId: "unreviewed" })).toEqual({ status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null });
  });

  it("reads reviewed nested API price and conversion amounts and retains their provenance", async () => {
    const f = fixture();
    f.plan.referencePriceSource = apiSource("reference");
    f.plan.conversionSources = [apiSource("conversion")];
    f.plan.deployments[0]!.claimUnit = "shares";
    f.plan.deployments[0]!.conversionSourceId = "conversion";
    const text = JSON.stringify(apiBody("1.25"));
    vi.mocked(fetch).mockImplementation(async () => new Response(text));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.referencePrice).toEqual({ sourceId: "reference", value: "1.25", observedAtSec: CLOCK - 60, sourceGeneration: "issuer-snapshot", responseSha256: sha256Hex(text) });
    expect(result.attribution.conversions[0]).toMatchObject({ sourceId: "conversion", value: "1.25" });
  });

  it.each(["01", "1e3", "-1", ".5", "1.", "0", "9".repeat(400)])("rejects invalid reviewed API amount %s", async amount => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(apiBody(amount))));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it.each([undefined, CLOCK - 86400, CLOCK + 1])("rejects missing, stale or future API observation time %s", async time => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    const body = apiBody(); body.data.observedAt = time;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it.each(["malformed JSON", "HTTP error"])("fails closed on reviewed API %s", async failure => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    vi.mocked(fetch).mockResolvedValue(failure === "malformed JSON" ? new Response("{") : new Response(JSON.stringify(apiBody()), { status: 503 }));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: failure === "malformed JSON" ? "deployment-state-unavailable" : "packet-reconciliation-failed" });
  });

  it("reads balance exclusions and pending liabilities without counting excluded holdings", async () => {
    const f = fixture();
    const row = f.plan.deployments[0]!;
    row.read = { kind: "evm-balance", safeBlockLag: 2, account: `0x${"2".repeat(40)}` };
    f.plan.exclusions = [{ id: "treasury", deploymentKey: row.deploymentKey, account: `0x${"3".repeat(40)}` }];
    f.plan.liabilityInFlightSource = apiSource("pending");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(apiBody("1000000"))));
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) => calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n : call.label === "treasury" ? 20000000n : 100000000n) })));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 80 / 81);
    expect(result.attribution.unattributedSupplyUsd).toBeCloseTo(100 / 81);
    expect(result.attribution.inFlight[0]).toMatchObject({ id: "in-flight:liability", amount: "1000000" });
  });

  function pendingFixture(pendingAmount = 1000000n, escrowAmount = 20000000n) {
    const f = fixture(), canonical = f.plan.deployments[0]!;
    const receipt = { ...canonical, deploymentKey: `base:0x${"2".repeat(40)}`, chainId: "base", address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(receipt);
    f.plan.accountingFamily = "lock-mint";
    const messageId = `0x${"f".repeat(64)}`;
    f.plan.escrows = [{ id: "bridge", canonicalDeploymentKey: canonical.deploymentKey, account: `0x${"3".repeat(40)}`,
      receiptDeploymentKeys: [receipt.deploymentKey], receiptClaimSources: [], independentReceiptLiability: false,
      inFlightSource: { kind: "evm-pending-state", sourceId: "pending", chainId: "ethereum", bridgeAddress: `0x${"3".repeat(40)}`,
        bridgeRuntimeCodeSha256: sha256Hex("0x6000"), finality: "finalized", messageCountSelector: "0x11111111",
        messageIdSelector: "0x22222222", pendingAmountSelector: "0x33333333", messageIds: [messageId] } }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n :
        call.label === "bridge" ? escrowAmount : call.label === receipt.deploymentKey ? 19000000n : 100000000n) })));
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (_chain, calls) =>
      calls[0]!.method === "eth_getCode" ? ["0x6000", word(1n)] : [messageId, word(pendingAmount)]);
    return f;
  }

  it("conserves independently observed finalized pending messages without counting them as free float", async () => {
    const result = await pendingFixture().run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(result.attribution.unattributedSupplyUsd).toBe(1);
    expect(result.attribution.inFlight[0]).toMatchObject({ amount: "1000000", anchor: "100", anchorHash: HASH });
  });

  it.each(["missing", "identity", "count", "code", "not finalized"])("rejects an unavailable or unauthenticated pending %s read", async failure => {
    const f = pendingFixture();
    if (failure === "not finalized") vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 99 : number, timestamp: CLOCK - 60, hash: HASH }));
    else vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (_chain, calls) =>
      failure === "missing" ? null : calls[0]!.method === "eth_getCode" ?
        [failure === "code" ? "0x6001" : "0x6000", word(failure === "count" ? 2n : 1n)] :
        [word(0n), word(1000000n)]);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "bridge" });
  });

  it("admits an empty pending queue only after a successful authenticated zero-count read", async () => {
    const f = pendingFixture(0n, 19000000n);
    const source = f.plan.escrows[0]!.inFlightSource!;
    if (!("kind" in source) || source.kind !== "evm-pending-state") throw new Error("Expected enumerable on-chain pending source");
    source.messageIds = [];
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(["0x6000", word(0n)]);
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.unattributedSupplyUsd).toBe(0);
    expect(result.attribution.inFlight[0]!.amount).toBe("0");
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(null);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
  });

  it("does not turn escrow surplus into pending supply", async () => {
    expect(await pendingFixture(0n).run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it("uses reviewed receipt subsets and API pending amounts to conserve the escrow rather than its gross receipt supply", async () => {
    const f = pendingFixture(), escrow = f.plan.escrows[0]!;
    escrow.receiptClaimSources = [{ deploymentKey: escrow.receiptDeploymentKeys[0]!, source: apiSource("receipt") }];
    escrow.inFlightSource = apiSource("pending");
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(apiBody(
      String(url).endsWith("/receipt") ? "19000000" : "1000000",
    ))));
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      deployments: [expect.objectContaining({ currentSupplyUsd: 80 }), expect.objectContaining({ currentSupplyUsd: 19 })],
      unattributedSupplyUsd: 1,
      observations: expect.arrayContaining([expect.objectContaining({
        id: `receipt:bridge:${escrow.receiptDeploymentKeys[0]}`, amount: "19000000", anchor: "issuer-snapshot",
      })]),
      inFlight: [expect.objectContaining({ amount: "1000000", anchor: "issuer-snapshot" })],
    } });
  });

  it.each(["receipt", "pending"])("rejects unavailable API %s accounting instead of replacing it with a residual", async failure => {
    const f = pendingFixture(), escrow = f.plan.escrows[0]!;
    escrow.receiptClaimSources = [{ deploymentKey: escrow.receiptDeploymentKeys[0]!, source: apiSource("receipt") }];
    escrow.inFlightSource = apiSource("pending");
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith(`/${failure}`)
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify(apiBody("19000000"))));
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: failure === "receipt" ? escrow.receiptDeploymentKeys[0] : escrow.id,
    });
  });

  function oftFixture(liability = false) {
    const f = pendingFixture(0n, 19000000n), [canonical, receipt] = f.plan.deployments;
    const side = (row: typeof canonical, eid: number, endpoint: string) => ({
      chainId: row!.chainId, tokenAddress: row!.address!, oappAddress: row!.address!,
      oappRuntimeCodeSha256: sha256Hex("0x6000"), endpointAddress: endpoint,
      endpointRuntimeCodeSha256: sha256Hex("0x6000"), eid, localDecimals: 6, deploymentBlock: 100,
    });
    const source: LayerZeroOftPendingRead = {
      kind: "evm-layerzero-oft-pending", sourceId: "oft", chainId: "ethereum", finality: "finalized",
      localDecimals: 6, sharedDecimals: 6,
      sides: [side(canonical, 30101, `0x${"4".repeat(40)}`), side(receipt, 30184, `0x${"5".repeat(40)}`)],
      pathways: [{ sourceIndex: 0, destinationIndex: 1 }],
    };
    if (liability) {
      f.plan.accountingFamily = "independent-liability";
      f.plan.escrows = [];
      f.plan.liabilityInFlightSource = source;
    } else {
      f.plan.escrows[0]!.account = source.sides[0]!.oappAddress;
      f.plan.escrows[0]!.inFlightSource = source;
    }
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: [] })));
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (chain, calls) => calls.map(call => {
      if (call.method === "eth_getCode") return "0x6000";
      const query = call.params[0];
      if (!query || typeof query !== "object" || !("data" in query) || typeof query.data !== "string") {
        throw new Error("Expected OFT eth_call query");
      }
      const data = query.data.slice(0, 10);
      const index = chain === "ethereum" ? 0 : 1, local = source.sides[index]!, remote = source.sides[1 - index]!;
      const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
      if (data === toFunctionSelector("endpoint()")) return addressWord(local.endpointAddress);
      if (data === toFunctionSelector("eid()")) return word(BigInt(local.eid));
      if (data === toFunctionSelector("token()")) return addressWord(local.tokenAddress);
      if (data === toFunctionSelector("decimals()") || data === toFunctionSelector("sharedDecimals()")) return word(6n);
      if (data === toFunctionSelector("decimalConversionRate()")) return word(1n);
      if (data === toFunctionSelector("peers(uint32)")) return addressWord(remote.oappAddress);
      if (["outboundNonce(address,uint32,bytes32)", "inboundNonce(address,uint32,bytes32)", "lazyInboundNonce(address,uint32,bytes32)"]
        .some(signature => data === toFunctionSelector(signature))) return word(0n);
      throw new Error(`Unexpected OFT state read ${data}`);
    }));
    return { ...f, source };
  }

  it.each([false, true])("retains authenticated zero OFT pending proof for liability=%s without inventing free float", async liability => {
    const f = oftFixture(liability);
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      unattributedSupplyUsd: 0,
      inFlight: [expect.objectContaining({
        id: liability ? "in-flight:liability" : "in-flight:bridge",
        amount: "0", anchor: "100", anchorHash: HASH,
        layerZeroOftPendingProof: expect.objectContaining({
          pathways: [expect.objectContaining({ sentNonce: "0", pendingCount: 0 })],
        }),
      })],
    } });
  });

  it.each([false, true])("fails closed on unauthenticated OFT runtime for liability=%s", async liability => {
    const f = oftFixture(liability);
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(["0x6001"]);
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: liability ? "in-flight:liability:runtime-mismatch" : "bridge",
    });
  });

  it.each([false, true])("surfaces CCIP finality rejection for liability=%s without assuming no pending messages", async liability => {
    const f = pendingFixture(), [canonical, receipt] = f.plan.deployments;
    const pool = f.plan.escrows[0]!.account;
    const side = (row: typeof canonical, chainSelector: string, tokenPoolAddress: string) => ({
      chainId: row!.chainId, chainSelector, tokenAddress: row!.address!, tokenPoolAddress,
      tokenPoolRuntimeCodeSha256: sha256Hex("0x6000"), decimals: 6,
    });
    const source: CcipPendingRead = {
      kind: "evm-ccip-pending", sourceId: "ccip", chainId: "ethereum", finality: "finalized", amountDecimals: 6,
      lanes: [{ id: "eth-base", version: "1.6", source: side(canonical, "1", pool),
        destination: side(receipt, "2", `0x${"4".repeat(40)}`), onRampAddress: `0x${"5".repeat(40)}`,
        offRampAddress: `0x${"6".repeat(40)}`, onRampRuntimeCodeSha256: sha256Hex("0x6000"),
        offRampRuntimeCodeSha256: sha256Hex("0x6000"), sourceStartBlock: 100 }],
    };
    if (liability) {
      f.plan.accountingFamily = "independent-liability"; f.plan.escrows = []; f.plan.liabilityInFlightSource = source;
    } else f.plan.escrows[0]!.inFlightSource = source;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 99 : number, timestamp: CLOCK - 60, hash: HASH,
    }));
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: `${liability ? "in-flight:liability" : "bridge"}:pin-not-finalized` });
  });

  it("surfaces an unfinalized canonical messenger census without substituting escrow surplus", async () => {
    const f = pendingFixture(), [canonical, receipt] = f.plan.deployments;
    const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    f.plan.escrows[0]!.inFlightSource = {
      kind: "evm-l2-messenger-pending", protocol: "op-stack", bridgeFlavor: "sky",
      sourceId: "messenger", chainId: "ethereum", l2ChainId: "base", finality: "finalized",
      l1Token: canonical!.address!, l2Token: receipt!.address!, escrowAddress: f.plan.escrows[0]!.account,
      l1Bridge: address(10), l2Bridge: address(11), l1Messenger: address(12), l2Messenger: address(13),
      messagePasser: address(14), portal: address(15), l1StartBlock: 100, l2StartBlock: 100,
      scanPageBlocks: [100, 100],
      contracts: [
        ...[10, 12, 15].map(n => ({ chainId: "ethereum", address: address(n), runtimeCodeSha256: sha256Hex("0x6000") })),
        ...[11, 13, 14].map(n => ({ chainId: "base", address: address(n), runtimeCodeSha256: sha256Hex("0x6000") })),
      ],
      identityReads: [{ chainId: "ethereum", address: address(10), method: "eth_call", data: "0x12345678", expected: word(1n) }],
    };
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 99 : number, timestamp: CLOCK - 60, hash: HASH,
    }));
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "bridge:pin-not-finalized",
    });
  });

  it.each(["number", "hash"])("rejects pending generations whose escrow block %s changed", async failure => {
    const f = pendingFixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 100 : number, timestamp: CLOCK - 60, hash: HASH,
    })).mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: failure === "number" ? 101 : 100, timestamp: CLOCK - 60,
        hash: failure === "hash" ? `0x${"b".repeat(64)}` : HASH });
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-invalid" });
  });

  it("reconciles provider-chain observations against the admitted aggregate", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    row.read = { kind: "provider-chain", sourceChain: "ethereum" }; row.amountBasis = "circulating-usd"; row.decimals = null;
    f.fixedInput.chainCirculatingById = { alpha: { ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
    f.fixedInput.chainCirculatingById.alpha!.ethereum!.current = 80;
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { unattributedSupplyUsd: 20 } });
    f.fixedInput.chainCirculatingById.alpha!.base = { ...f.fixedInput.chainCirculatingById.alpha!.ethereum!, current: 1 };
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: "provider:base" });
  });

  it.each([["Ethereum", "ethereum"], ["Fraxtal", "fraxtal"]])("reconciles the provider label %s with canonical deployment identity", async (label, chainId) => {
    const f = fixture(), row = f.plan.deployments[0]!;
    row.chainId = chainId;
    row.deploymentKey = `${chainId}:${row.address}`;
    f.fixedInput.chainCirculatingById = { alpha: { [label]: {
      current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100,
    } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      deployments: [expect.objectContaining({ chainId, currentSupplyUsd: 100 })],
    } });
    f.fixedInput.chainCirculatingById.alpha![label]!.current = 90;
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: `provider:${label}` });
  });
  it("sums provider aliases before comparing their conserved economic allocation", async () => {
    const f = fixture(), template = { current: 60, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 };
    f.fixedInput.chainCirculatingById = { alpha: { Ethereum: template, ethereum: { ...template, current: 40 } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
    f.fixedInput.chainCirculatingById.alpha!.ethereum!.current = 30;
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it("propagates cancellation instead of manufacturing a rejection packet", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("finalized Solana mint observations", () => {
  function mockSolana(overrides: Record<string, unknown> = {}) {
    const results: Record<string, unknown> = { getAccountInfo: account(), getBlocks: [100], getBlock: { blockTime: CLOCK - 60, blockhash: "a".repeat(44) }, ...overrides };
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method as string;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[method] }));
    });
  }
  it("rejects an earlier produced block that does not certify the account context slot", async () => {
    mockSolana({ getBlocks: [99], getBlock: { blockTime: CLOCK - 1, blockhash: "a".repeat(44) } });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK, requireExactContextSlot: true })).toBeNull();
    const f = fixture(), row = f.plan.deployments[0]!;
    Object.assign(row, { deploymentKey: `solana:${MINT}`, chainId: "solana", address: MINT, read: { kind: "solana-mint", programOwner: OWNER } });
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: row.deploymentKey });
  });
  it("includes the Solana read in the conserved reviewed partition", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    Object.assign(row, { deploymentKey: `solana:${MINT}`, chainId: "solana", address: MINT, read: { kind: "solana-mint", programOwner: OWNER } });
    mockSolana();
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { observations: [expect.objectContaining({ amount: "100000000", anchor: "100:100" })], deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
  });
  it.each(["01", "1.5", "-1"])("rejects noncanonical mint supply %s", async supply => {
    mockSolana({ getAccountInfo: account(supply) });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it.each(["owner", "decimals", "slots", "missing clock", "stale clock", "future clock", "hash"])("fails closed on invalid Solana %s", async failure => {
    const mint = account();
    if (failure === "owner") mint.value.owner = "UnreviewedProgram";
    if (failure === "decimals") mint.value.data.parsed.info.decimals = 18;
    mockSolana({ getAccountInfo: mint, ...(failure === "slots" ? { getBlocks: [1, 101] } : {}), getBlock: { blockTime: failure === "missing clock" ? undefined : failure === "stale clock" ? CLOCK - 1801 : failure === "future clock" ? CLOCK + 1 : CLOCK - 60, blockhash: failure === "hash" ? "invalid0" : "a".repeat(44) } });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it("rejects oversized RPC envelopes without admitting their otherwise valid mint", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ result: account() }), { headers: { "content-length": "128001" } }));
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it("propagates an already aborted Solana request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("validated XRPL issued-currency observations", () => {
  function xrplFixture(failure?: string) {
    const f = fixture(); const row = f.plan.deployments[0]!;
    const issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    Object.assign(row, { deploymentKey: `xrpl:USD.${issuer}`, chainId: "xrpl", address: `USD.${issuer}`, amountBasis: "issued-currency-decimal", decimals: null, read: { kind: "xrpl-issued-currency", currency: "USD", issuer } });
    f.chainRpcs.set("xrpl", { chainId: "xrpl", chainName: "XRP Ledger", type: "other", explorerUrl: "https://xrpscan.com", endpoints: [{ url: "https://xrpl.example/rpc", operator: "public", keyed: false, position: "registry", stateHistory: "recent", logsHistory: "none" }] });
    const hash = "A".repeat(64);
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method;
      if (failure === "malformed") return new Response("{");
      return new Response(JSON.stringify({ result: method === "gateway_balances" ? { validated: failure !== "unvalidated", ledger_index: 100, ledger_hash: hash, obligations: { USD: failure === "negative" ? "-100" : "1.00e2" } } : { ledger: { ledger_hash: failure === "hash mismatch" ? "B".repeat(64) : hash, close_time: failure === "missing time" ? undefined : CLOCK - (failure === "stale time" ? 1801 : 60) - 946684800 } } }));
    });
    return f;
  }
  it("reads liabilities and the pinned ledger close time, normalizing amount and hash", async () => {
    const result = await xrplFixture().run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.observations[0]).toMatchObject({ amount: "100", anchor: "100", anchorHash: "a".repeat(64), observedAtSec: CLOCK - 60 });
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBe(100);
  });
  it.each(["malformed", "negative", "unvalidated", "hash mismatch", "missing time", "stale time"])("rejects XRPL %s", async failure => {
    expect(await xrplFixture(failure).run()).toMatchObject({ status: "rejected", rejectionCode: failure === "stale time" ? "packet-reconciliation-failed" : "deployment-state-unavailable" });
  });
});

describe("identity-bound non-EVM economic supply", () => {
  const metadataAddress = `0x${"b".repeat(64)}`;
  const master = "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr";
  const pin = { workchain: -1, shard: "-9223372036854775808", seqno: 97048839,
    root_hash: "G++xuEKh8vIc5zIdqmuZXGKyAKbwCiAqzTKEsTSI3OM=", file_hash: "VsEwupusnpifJYRlFR4f9cZ1vJqpnxb9Huywp8jBA90=" };
  function nonEvmFixture(chainId: "aptos" | "movement" | "ton", failure?: string) {
    const f = fixture(), row = f.plan.deployments[0]!;
    const address = chainId === "ton" ? master : metadataAddress;
    Object.assign(row, { deploymentKey: `${chainId}:${address}`, chainId, address, read: chainId === "ton"
      ? { kind: "ton-jetton-supply", apiUrl: "https://ton.example/api/v2" }
      : { kind: "move-fa-supply", identityKind: "metadata-address", metadataAddress, ledgerChainId: chainId === "aptos" ? 1 : 126 } });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url);
      let result: unknown;
      if (chainId !== "ton") {
        if (path.includes("ConcurrentSupply")) result = { type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "100000000" } } };
        else if (path.includes("Metadata")) result = { type: "0x1::fungible_asset::Metadata", data: { decimals: failure === "decimals" ? 18 : 6 } };
        else if (path.includes("ObjectCore")) result = { type: "0x1::object::ObjectCore", data: { transfer_events: { guid: { id: { addr: failure === "identity" ? "0x123" : metadataAddress } } } } };
        else result = { chain_id: chainId === "aptos" ? 1 : 126, ledger_version: failure === "pin" ? undefined : "100",
          ledger_timestamp: failure === "timestamp" ? undefined : String((CLOCK - 60) * 1_000_000) };
      } else {
        if (path.includes("getMasterchainInfo")) result = { ok: true, result: { last: pin } };
        else if (path.includes("lookupBlock")) result = { ok: true, result: pin };
        else if (path.includes("getBlockHeader")) result = { ok: true, result: { id: pin, global_id: -239, gen_utime: failure === "timestamp" ? undefined : CLOCK - 60 } };
        else if (init?.method === "POST" && path.endsWith("runGetMethod")) result = { ok: true, result: { exit_code: 0, block_id: failure === "pin" ? undefined : pin, stack: [["num", "0x5f5e100"]] } };
        else result = { ok: true, result: { address: failure === "identity" ? "other-master" : master, contract_type: "jetton_master", total_supply: "100000000",
          jetton_content: { type: "onchain", data: { decimals: failure === "decimals" ? "18" : "6" } } } };
      }
      return new Response(JSON.stringify(result));
    });
    return f;
  }
  it.each(["aptos", "movement", "ton"] as const)("admits %s supply to the conserved census without rewriting the provider aggregate", async chainId => {
    const f = nonEvmFixture(chainId);
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(true);
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      aggregate: { supplyUsd: 100, observedAtSec: CLOCK - 60 }, quantitativeCompleteness: true,
      observations: [expect.objectContaining({ amount: "100000000", anchor: chainId === "ton" ? String(pin.seqno) : "100", observedAtSec: CLOCK - 60 })],
      deployments: [expect.objectContaining({ currentSupplyUsd: 100 })],
    } });
  });
  it.each(["aptos", "movement", "ton"] as const)("rejects %s wrong metadata, missing chronology and decimals", async chainId => {
    for (const failure of ["identity", "pin", "timestamp", "decimals"]) {
      expect(await nonEvmFixture(chainId, failure).run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
    }
  });
  it("rejects Move plan metadata and ledger-chain mismatches before observation", () => {
    const f = nonEvmFixture("aptos"), row = f.plan.deployments[0]!;
    if (row.read.kind !== "move-fa-supply") throw new Error("Expected Move read");
    row.read.metadataAddress = "0x123";
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(false);
    row.read.metadataAddress = metadataAddress;
    row.read.ledgerChainId = 126;
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(false);
  });
  it.each(["aptos", "ton"] as const)("rejects missing persisted %s anchor identity rather than trusting conserved rows", async chainId => {
    const f = nonEvmFixture(chainId), result = await f.run();
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    const validate = () => reviewedEconomicDeploymentAttributionValidationError({
      assetId: "alpha", attribution: result.attribution, aggregateSupplyUsd: 100,
      registryFingerprint: f.fixedInput.registryFingerprint, clockSec: CLOCK,
    });
    expect(validate()).toBeNull();
    const observation = result.attribution.observations[0]!;
    const anchor = observation.anchor;
    observation.anchor = "latest";
    expect(validate()).toBe("Economic supply attribution accounting/census invalid");
    observation.anchor = anchor;
    observation.anchorHash = "unpinned";
    expect(validate()).toBe("Economic supply attribution accounting/census invalid");
  });
});

describe("nonce-authenticated Curve LayerZero pending history", () => {
  function curveFixture() {
    const source: CurveLzPendingRead = {
      kind: "evm-curve-lz-pending", sourceId: "curve-pending", chainId: "ethereum", finality: "finalized",
      sides: [0, 1].map((index) => ({
        chainId: index === 0 ? "ethereum" : "base",
        bridgeAddress: `0x${String(index + 3).repeat(40)}`,
        bridgeRuntimeCodeSha256: sha256Hex("0x6000"),
        endpointAddress: `0x${String(index + 5).repeat(40)}`,
        endpointRuntimeCodeSha256: sha256Hex("0x6000"),
        lzChainId: index === 0 ? 101 : 184, deploymentBlock: 90,
        sendLibraries: [{ address: `0x${String(index + 7).repeat(40)}`, runtimeCodeSha256: sha256Hex("0x6000"), encoding: "packet-v1" as const }],
        outboundNonceRead: { address: `0x${String(index + 5).repeat(40)}`, runtimeCodeSha256: sha256Hex("0x6000"), callData: "0x11111111" },
        supportsFailed: index === 0,
      })) as CurveLzPendingRead["sides"],
    };
    const receiver = `0x${"9".repeat(40)}` as `0x${string}`;
    const payload = encodeAbiParameters(parseAbiParameters("address,uint256"), [receiver, 1000000n]);
    const topic = (name: string) => keccak256(toHex(name));
    const sent: Array<Array<Record<string, unknown>>> = [[], []], received: Array<Array<Record<string, unknown>>> = [[], []];
    const rawLog = (address: string, topics: string[], data: string, height = 95, index = 0) =>
      ({ address, topics, data, blockNumber: `0x${height.toString(16)}`, blockHash: HASH, transactionHash: HASH, logIndex: `0x${index.toString(16)}`, removed: false });
    const send = (i: number, nonce = 1n, index = 0) => {
      const a = source.sides[i]!, b = source.sides[1 - i]!;
      const packet = `0x${nonce.toString(16).padStart(16, "0")}${a.lzChainId.toString(16).padStart(4, "0")}${a.bridgeAddress.slice(2)}${b.lzChainId.toString(16).padStart(4, "0")}${b.bridgeAddress.slice(2)}${payload.slice(2)}` as `0x${string}`;
      sent[i]!.push(rawLog(a.sendLibraries[0]!.address, [topic("Packet(bytes)")], encodeAbiParameters(parseAbiParameters("bytes"), [packet]), 95, index));
    };
    const receive = (direction: number, name = "Delayed", nonce = 1n, index = 0) => {
      const side = 1 - direction;
      received[side]!.push(rawLog(source.sides[side]!.bridgeAddress, [topic(`${name}(uint64,address,uint256)`), word(nonce), `0x${receiver.slice(2).padStart(64, "0")}`], word(1000000n), 96, index));
    };
    let badCommitment = false;
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (chain, calls) => {
      const i = chain === "ethereum" ? 0 : 1, side = source.sides[i]!;
      if (calls[0]!.method === "eth_getCode") return calls.map(() => "0x6000");
      if (calls[0]!.method === "eth_getLogs") {
        const params = calls[0]!.params[0] as { address: string | string[]; fromBlock: string; toBlock: string };
        const rows = Array.isArray(params.address) ? sent[i]! : received[i]!;
        return [rows.filter(row => BigInt(row.blockNumber as string) >= BigInt(params.fromBlock) && BigInt(row.blockNumber as string) <= BigInt(params.toBlock))];
      }
      if (calls[0]!.method === "eth_getTransactionByHash") return [{ hash: HASH, to: side.bridgeAddress, input: toFunctionSelector("bridge(uint256)") + word(1000000n).slice(2) }];
      const call = calls[0]!.params[0] as { data: string };
      if (call.data === toFunctionSelector("LZ_ENDPOINT()")) return [`0x${side.endpointAddress.slice(2).padStart(64, "0")}`, word(BigInt(source.sides[1 - i]!.lzChainId))];
      if (call.data === "0x11111111") return [word(BigInt(sent[i]!.length))];
      if (call.data.startsWith(toFunctionSelector("getInboundNonce(uint16,bytes)"))) return [word(BigInt(received[i]!.filter(row => (row.topics as string[])[0] !== topic("Issued(uint64,address,uint256)")).length))];
      if (call.data.startsWith(toFunctionSelector("delayed(uint64)"))) return [badCommitment ? word(0n) : keccak256(encodeAbiParameters(parseAbiParameters("uint256,bytes"), [BigInt(CLOCK - 60), payload]))];
      if (call.data.startsWith(toFunctionSelector("failed(uint64)"))) return [keccak256(payload)];
      throw new Error("Unexpected RPC method");
    });
    const input = { source, headers: [{ number: 100, timestamp: CLOCK - 60, hash: HASH }, { number: 100, timestamp: CLOCK - 60, hash: HASH }], chainRpcs: new Map<string, ChainRpcConfig>() };
    return { input, send, receive, sent, received, rejectCommitment() { badCommitment = true; } };
  }

  it("authenticates delayed commitments in both directions without estimating an escrow residual", async () => {
    const f = curveFixture(); f.send(0); f.receive(0); f.send(1); f.receive(1, "Failed");
    const result = await observeCurveLzPending(f.input);
    expect(result).toMatchObject({ status: "accepted", amount: "2000000", proof: { pins: [expect.objectContaining({ chainId: "ethereum" }), expect.objectContaining({ chainId: "base" })] } });
  });

  it("counts an authenticated source send not yet delivered to the destination", async () => {
    const f = curveFixture(); f.send(0);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "accepted", amount: "1000000" });
  });

  it("resumes contiguous bounded history and admits zero only after all four streams finish", async () => {
    const f = curveFixture();
    f.input.headers[0]!.number = 30000; f.input.headers[1]!.number = 30000;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 30000 : number, timestamp: CLOCK - 60, hash: HASH }));
    let result = await observeCurveLzPending(f.input);
    for (let attempt = 0; attempt < 8 && result.status === "rejected"; attempt++) {
      expect(result.reason).toBe("history-incomplete");
      if (!result.checkpoint) throw new Error("Expected bounded progress");
      result = await observeCurveLzPending({ ...f.input, checkpoint: result.checkpoint });
    }
    expect(result).toMatchObject({ status: "accepted", amount: "0" });
  });

  it("rejects a missing source nonce rather than treating a partial event book as complete", async () => {
    const f = curveFixture(); f.send(0, 2n);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "missing-nonce" });
  });

  it("rejects a replayed nonce in another valid log position", async () => {
    const f = curveFixture(); f.send(0); f.send(0, 1n, 1);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "replayed-nonce" });
  });

  it("rejects replayed consumption of an already issued nonce", async () => {
    const f = curveFixture(); f.send(0); f.receive(0, "Issued"); f.receive(0, "Issued", 1n, 1);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "replayed-or-missing-nonce" });
  });

  it("retains a bounded catch-up checkpoint without publishing a partial pending quantity", async () => {
    const f = curveFixture();
    f.input.headers[0]!.number = 30000; f.input.headers[1]!.number = 30000;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 30000 : number, timestamp: CLOCK - 60, hash: HASH }));
    const first = await observeCurveLzPending(f.input);
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Expected catch-up checkpoint");
    expect(first.checkpoint.directions[0]!.sent.nextBlock).toBe(16090);
    first.checkpoint.directions[0]!.sent.nextBlock++;
    expect(await observeCurveLzPending({ ...f.input, checkpoint: first.checkpoint })).toMatchObject({ status: "rejected", reason: "history-gap" });
  });

  it("rejects a cleared delayed commitment without a matching Issued event", async () => {
    const f = curveFixture(); f.send(0); f.receive(0); f.rejectCommitment();
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "commitment-mismatch" });
  });

  it("feeds a conserved canonical-free/receipt/pending partition into existing admission", async () => {
    const f = fixture(), history = curveFixture(), canonical = f.plan.deployments[0]!;
    history.send(0); history.receive(0);
    const receipt = { ...canonical, deploymentKey: `base:0x${"2".repeat(40)}`, chainId: "base", address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(receipt);
    f.plan.accountingFamily = "lock-mint";
    f.plan.escrows = [{ id: "bridge", canonicalDeploymentKey: canonical.deploymentKey, account: history.input.source.sides[0].bridgeAddress,
      receiptDeploymentKeys: [receipt.deploymentKey], receiptClaimSources: [], independentReceiptLiability: false, inFlightSource: history.input.source }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n :
        call.label === "bridge" ? 20000000n : call.label === receipt.deploymentKey ? 19000000n : 100000000n) })));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected conserved partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(result.attribution.unattributedSupplyUsd).toBe(1);
    expect(result.attribution.inFlight[0]!.curvePendingProof).toBeDefined();
  });
});
