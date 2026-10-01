import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sha256Hex } from "@shared/lib/sha256";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import * as evmRpc from "../evm-rpc";
import type { ChainRpcConfig } from "../chain-registry";
import { observeEconomicSolanaMint, observeReviewedEconomicDeploymentPartitionAttempt } from "../safety-score-v9/economic-supply-observer";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS } from "../safety-score-v9/supply-attribution-contract";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = 1790850000;
const HASH = `0x${"a".repeat(64)}`;
const OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "So11111111111111111111111111111111111111112";
const apiSource = (sourceId: string) => ({ sourceId, url: `https://issuer.example/${sourceId}`, amountPath: ["data", "amount"], observedAtPath: ["data", "observedAt"], generationPath: ["data", "generation"] });
const apiBody = (amount: unknown = "1", observedAt: unknown = CLOCK - 60) => ({ data: { amount, observedAt, generation: "issuer-snapshot" } });
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
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
  return { plan, fixedInput, assetId: "alpha", chainRpcs, run(signal?: AbortSignal) { return observeReviewedEconomicDeploymentPartitionAttempt({ assetId: "alpha", fixedInput, chainRpcs, signal }); } };
}

beforeEach(() => {
  vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockResolvedValue(102);
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (_chain, number) => ({ number, timestamp: CLOCK - 60, hash: HASH }));
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
    delete f.fixedInput.aggregateCirculatingById.alpha!.observedAtSec;
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

  it("reconciles provider-chain observations against the admitted aggregate", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    row.read = { kind: "provider-chain", sourceChain: "ethereum" }; row.amountBasis = "circulating-usd"; row.decimals = null;
    f.fixedInput.chainCirculatingById = { alpha: { ethereum: { current: 100 } } } as typeof f.fixedInput.chainCirculatingById;
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
    f.fixedInput.chainCirculatingById.alpha!.ethereum!.current = 80;
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { unattributedSupplyUsd: 20 } });
    f.fixedInput.chainCirculatingById.alpha!.base = { ...f.fixedInput.chainCirculatingById.alpha!.ethereum!, current: 1 };
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: "provider:base" });
  });

  it("propagates cancellation instead of manufacturing a rejection packet", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("finalized Solana mint observations", () => {
  function mockSolana(overrides: Record<string, unknown> = {}) {
    const results: Record<string, unknown> = { getAccountInfo: account(), getBlocks: [40, 98, 99, 101], getBlock: { blockTime: CLOCK - 60, blockhash: "a".repeat(44) }, ...overrides };
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method as string;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[method] }));
    });
  }
  it("returns finalized supply anchored to the latest produced block and preserves mint identity", async () => {
    mockSolana();
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, programOwner: OWNER, clockSec: CLOCK })).toEqual({ amount: "100000000", slot: "100:99", blockHash: "a".repeat(44), observedAtSec: CLOCK - 60, responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("includes the Solana read in the conserved reviewed partition", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    Object.assign(row, { deploymentKey: `solana:${MINT}`, chainId: "solana", address: MINT, read: { kind: "solana-mint", programOwner: OWNER } });
    mockSolana();
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { observations: [expect.objectContaining({ amount: "100000000", anchor: "100:99" })], deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
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
