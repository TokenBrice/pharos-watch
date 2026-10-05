import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmosBankSupplyReadSchema, ReviewedEconomicSupplyPlanSchema, type CosmosBankSupplyRead, type ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import { observeEconomicCosmosBank, pinEconomicCosmosBank } from "../safety-score-v9/cosmos-bank-observer";
import { deriveReviewedEconomicDeploymentPartition, REVIEWED_ECONOMIC_SUPPLY_PLANS } from "../safety-score-v9/supply-attribution-contract";
import { observeReviewedEconomicDeploymentPartitionAttempt } from "../safety-score-v9/economic-supply-observer";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = 1791184659;
const HASH = "a".repeat(64);
const ESCROW = "kava1kq2rzz6fq2q7fsu75a9g7cpzjeanmk685s3zdn";
const RECEIPT = "ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE";
const source: CosmosBankSupplyRead = { kind: "cosmos-bank-supply", restUrl: "https://kava.example/", ledgerChainId: "kava_2222-10", denom: "usdx", safeBlockLag: 3 };
const pin = { height: "100", blockHash: HASH, observedAtSec: CLOCK - 60 };
const header = (height = "100", time = CLOCK - 60, hash = HASH, chain = source.ledgerChainId) => ({ block_id: { hash }, block: { header: { height, time: new Date(time * 1000).toISOString(), chain_id: chain } } });
const response = (body: unknown, height: string | null = "100") => new Response(JSON.stringify(body), { headers: height === null ? {} : { "grpc-metadata-x-cosmos-block-height": height } });
function network() {
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/latest")) return response(header("103"), null);
    if (path.includes("/blocks/")) return response(header());
    return response(path.includes("/balances/") ? { balance: { denom: "usdx", amount: "20000000" } } : { amount: { denom: "usdx", amount: "100000000" } });
  }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("height-pinned Cosmos bank reads", () => {
  it("reads native supply and channel escrow at one finalized block and true block time", async () => {
    network();
    expect(await pinEconomicCosmosBank({ source, chainId: "kava", clockSec: CLOCK })).toEqual(pin);
    const supply = await observeEconomicCosmosBank({ source, chainId: "kava", pin, clockSec: CLOCK });
    const escrow = await observeEconomicCosmosBank({ source, chainId: "kava", pin, clockSec: CLOCK, account: ESCROW });
    expect(supply).toMatchObject({ amount: "100000000", anchor: "100", anchorHash: HASH, observedAtSec: CLOCK - 60 });
    expect(escrow).toMatchObject({ amount: "20000000", anchor: "100", anchorHash: HASH, observedAtSec: CLOCK - 60 });
    expect(supply!.responseSha256).not.toBe(escrow!.responseSha256);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      if (!new URL(String(url)).pathname.endsWith("/latest")) expect(options!.headers).toEqual({ "x-cosmos-block-height": "100" });
    }
  });
  it.each(["missing height", "wrong height", "conflicting height", "wrong denom", "null balance", "malformed amount", "http failure"])("rejects %s without treating it as zero", async failure => {
    network();
    const body = failure === "null balance" ? { balance: null } : { balance: { denom: failure === "wrong denom" ? "ukava" : "usdx", amount: failure === "malformed amount" ? "1e6" : "0" } };
    const result = response(body, failure === "missing height" ? null : failure === "wrong height" ? "99" : "100");
    if (failure === "conflicting height") result.headers.set("x-cosmos-block-height", "99");
    vi.mocked(fetch).mockResolvedValueOnce(failure === "http failure" ? new Response("unavailable", { status: 503 }) : result);
    expect(await observeEconomicCosmosBank({ source, chainId: "kava", pin, clockSec: CLOCK, account: ESCROW })).toBeNull();
  });
  it.each(["height", "time", "hash", "chain"])("rejects a changed block %s on recheck", async mismatch => {
    network();
    vi.mocked(fetch).mockResolvedValueOnce(response({ amount: { denom: "usdx", amount: "100" } }))
      .mockResolvedValueOnce(response(header(mismatch === "height" ? "99" : "100", mismatch === "time" ? CLOCK - 59 : CLOCK - 60, mismatch === "hash" ? "b".repeat(64) : HASH, mismatch === "chain" ? "wrong-chain" : source.ledgerChainId)));
    expect(await observeEconomicCosmosBank({ source, chainId: "kava", pin, clockSec: CLOCK })).toBeNull();
  });
  it.each([CLOCK + 1, CLOCK - 86400])("rejects unavailable scoring chronology %s", async time => {
    network();
    vi.mocked(fetch).mockResolvedValueOnce(response(header("103"), null)).mockResolvedValueOnce(response(header("100", time)));
    expect(await pinEconomicCosmosBank({ source, chainId: "kava", clockSec: CLOCK })).toBeNull();
  });
  it.each(["Z", ".0Z", ".123456789Z"])("accepts RFC3339 UTC block time suffix %s", async suffix => {
    network();
    const block = header();
    block.block.header.time = new Date((CLOCK - 60) * 1000).toISOString().slice(0, 19) + suffix;
    vi.mocked(fetch).mockResolvedValueOnce(response(header("103"), null)).mockResolvedValueOnce(response(block));
    expect(await pinEconomicCosmosBank({ source, chainId: "kava", clockSec: CLOCK })).toEqual(pin);
  });
  it.each([".Z", ".1234567890Z", ".1xZ", "+00:00", "ZZ"])("rejects malformed block time suffix %s", async suffix => {
    network();
    const block = header();
    block.block.header.time = new Date((CLOCK - 60) * 1000).toISOString().slice(0, 19) + suffix;
    vi.mocked(fetch).mockResolvedValueOnce(response(header("103"), null)).mockResolvedValueOnce(response(block));
    expect(await pinEconomicCosmosBank({ source, chainId: "kava", clockSec: CLOCK })).toBeNull();
  });
  it("accepts canonical Tendermint base64 block hashes, not arbitrary strings", async () => {
    network();
    vi.mocked(fetch).mockResolvedValueOnce(response(header("103"), null)).mockResolvedValueOnce(response(header("100", CLOCK - 60, btoa(String.fromCharCode(...new Array(32).fill(170))))));
    expect(await pinEconomicCosmosBank({ source, chainId: "kava", clockSec: CLOCK })).toEqual(pin);
  });
  it("rejects bank reads not bound to the registered native rail", async () => {
    network();
    expect(await pinEconomicCosmosBank({ source, chainId: "ethereum", clockSec: CLOCK })).toBeNull();
    expect(CosmosBankSupplyReadSchema.safeParse({ ...source, restUrl: "https://kava.example/hidden?latest=true" }).success).toBe(false);
    expect(await observeEconomicCosmosBank({ source, chainId: "kava", pin, clockSec: CLOCK, account: "osmo1wrong" })).toBeNull();
  });
});

function fixture() {
  const pending = { sourceId: "reviewed-packet-state", url: "https://kava.example/pending", amountPath: ["amount"], observedAtPath: ["time"], generationPath: ["height"] };
  const plan: ReviewedEconomicSupplyPlan = {
    assetId: "fixture", reviewer: "reviewer", reviewedAtSec: CLOCK - 86400, expiresAtSec: CLOCK + 86400,
    evidenceUrls: ["https://kava.example/accounting"], economicScope: "Exact native liability and separately authenticated ICS-20 receipt", sourceId: "reference",
    accountingFamily: "lock-mint", commonClaimUnit: "usdx", exhaustive: true, inFlightTreatment: "observed-reconciled",
    deployments: [
      { deploymentKey: "kava:usdx", chainId: "kava", address: "usdx", holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: null, read: source, claimUnit: "usdx", conversionSourceId: null },
      { deploymentKey: `osmosis:${RECEIPT}`, chainId: "osmosis", address: RECEIPT, holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: null, read: { ...source, restUrl: "https://osmosis.example/", ledgerChainId: "osmosis-1", denom: RECEIPT }, claimUnit: "usdx", conversionSourceId: null },
    ],
    excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
    escrows: [{ id: "channel-1-escrow", canonicalDeploymentKey: "kava:usdx", account: ESCROW, receiptDeploymentKeys: [`osmosis:${RECEIPT}`], independentReceiptLiability: false, receiptClaimSources: [], inFlightSource: pending }],
  };
  const meta = { contracts: [{ kind: "native-denom", chain: "kava", address: "usdx", decimals: 6 }, { chain: "osmosis", address: RECEIPT, decimals: 6 }] } as StablecoinMeta;
  const observation = (id: string, deploymentKey: string, amount: string) => ({ id, deploymentKey, amount, observedAtSec: CLOCK - 60, anchor: "100", anchorHash: HASH, responseSha256: "b".repeat(64) });
  return { plan, meta, baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "d".repeat(64), clockSec: CLOCK,
    aggregate: { supplyUsd: 100, sourceGeneration: "source", observedAtSec: CLOCK - 60 },
    referencePrice: { sourceId: "reference", sourceGeneration: "price", observedAtSec: CLOCK - 60, value: "1", responseSha256: "e".repeat(64) }, conversions: [],
    observations: [observation("kava:usdx", "kava:usdx", "100000000"), observation(`osmosis:${RECEIPT}`, `osmosis:${RECEIPT}`, "20000000"), observation("channel-1-escrow", "kava:usdx", "20000000")],
    inFlight: [observation("in-flight:channel-1-escrow", "kava:usdx", "0")],
  };
}
describe("native-plus-escrow conservation", () => {
  it("conserves native supply as free native plus escrow-backed receipts, never receipt share one", () => {
    const f = fixture();
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(true);
    const partition = deriveReviewedEconomicDeploymentPartition(f)!;
    expect(partition.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 20]);
    expect(partition.unattributedSupplyUsd).toBe(0);
    expect(partition.aggregate.supplyUsd).toBe(100);
  });
  it.each(["height", "hash", "time", "missing pending", "excess receipts", "wrong denom", "wrong ledger"])("rejects %s instead of manufacturing supply shares", mismatch => {
    const f = fixture();
    if (mismatch === "height") f.observations[2]!.anchor = "99";
    if (mismatch === "hash") f.observations[2]!.anchorHash = "f".repeat(64);
    if (mismatch === "time") f.observations[2]!.observedAtSec--;
    if (mismatch === "missing pending") f.inFlight = [];
    if (mismatch === "excess receipts") f.observations[1]!.amount = "20000001";
    if (mismatch === "wrong denom") f.plan.deployments[0]!.address = "ukava";
    if (mismatch === "wrong ledger") f.plan.deployments[0]!.read = { ...source, ledgerChainId: "osmosis-1" };
    expect(deriveReviewedEconomicDeploymentPartition(f)).toBeNull();
  });
  it("rejects a native bank denomination sent to an EVM reader or lacking its discriminator", () => {
    const f = fixture();
    f.plan.deployments[0]!.read = { kind: "evm-total-supply", safeBlockLag: 3 };
    expect(deriveReviewedEconomicDeploymentPartition(f)).toBeNull();
    f.plan.deployments[0]!.read = source;
    f.meta.contracts![0] = { chain: "kava", address: "usdx", decimals: 6 };
    expect(deriveReviewedEconomicDeploymentPartition(f)).toBeNull();
  });
  it("rejects unknown native exponents rather than assuming a scale during conservation", () => {
    const f = fixture();
    f.meta.contracts![0] = { kind: "native-denom", chain: "kava", address: "usdx", decimals: null };
    expect(deriveReviewedEconomicDeploymentPartition(f)).toBeNull();
    f.plan.deployments[0]!.decimals = null;
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(false);
  });
  it("dispatches native bank supply and exclusions through Cosmos, not EVM", async () => {
    network();
    const f = fixture();
    f.plan.deployments.pop(); f.plan.escrows = []; f.plan.accountingFamily = "independent-liability";
    f.plan.exclusions = [{ id: "escrow-exclusion", deploymentKey: "kava:usdx", account: ESCROW }];
    f.meta.contracts!.pop();
    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockImplementation(id => id === "fixture" ? f.plan : undefined);
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => id === "fixture" ? f.meta : undefined);
    const fixedInput = makeV9FixedInput({ assetId: "fixture", clockSec: CLOCK });
    Object.assign(fixedInput, { baseInputGenerationId: f.baseInputGenerationId, sourceGeneration: "source", registryFingerprint: f.registryFingerprint,
      aggregateCirculatingById: { fixture: { circulating: { peggedUSD: 80 }, observedAtSec: CLOCK - 60 } },
      chainCirculatingById: {}, navPriceById: { fixture: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } } });
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ assetId: "fixture", fixedInput, scoringClockSec: CLOCK, chainRpcs: new Map() })).toMatchObject({ status: "accepted", attribution: { deployments: [{ deploymentKey: "kava:usdx", currentSupplyUsd: 80 }] } });
  });
});
