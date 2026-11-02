import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/sui-clmm-checkpoints.json";
import inspections from "./fixtures/sui-clmm-inspections.json";
import shadowInspections from "./fixtures/sui-clmm-shadow-inspections.json";
import receipts from "./fixtures/sui-grpc-responses.json";
import { DEX_MEASURED_FRESHNESS_MAX_SEC, type DexRequestBudget } from "@shared/types/measured-execution";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { isDexExecutionProfileAdmittedForScoring, getDexExecutionCapabilityRegistration } from "@shared/lib/p4-exit-route-capability-policy";
import { SuiClmmShadowHistorySchema } from "@shared/types/sui-clmm";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { compactCronMetadataForPersistence } from "../../../lib/cron-metadata-persistence";
import { decodeSuiClmmSnapshot, suiObject, type SuiClmmCapture, type SuiRpc } from "../sui/state-reader";
import { quoteSuiClmmExactIn } from "../sui/clmm-quote";
import { createSuiTransactionCheckpointResolver } from "../sui/archival-checkpoints";
import { decodeSuiClmmInspectResults } from "../sui/independent-quote";
import { buildPoolIdentity } from "../pool-identity";
import { normalizeProtocol } from "../pool-normalization";
import { buildSuiClmmRegisteredExecutionTarget } from "../execution-targets/sui-clmm";
import { collectSuiClmmShadowQuotes, selectSuiShadowPools, observeSuiClmmShadowPool } from "../sui/shadow";
import * as stateReader from "../sui/state-reader";
import * as independentQuote from "../sui/independent-quote";
import { createSuiClmmGrpc, decodeSuiGrpcWebUnary } from "../sui/grpc";
import type { DexExecutionTargetFactoryInput } from "../execution-target-registry";

const pinned = fixtures.fixtures.map((fixture) => {
  const capture = fixture.capture as SuiClmmCapture;
  const nowSec = Math.floor(Number(fixture.capture.checkpoint.timestampMs) / 1000);
  return { fixture, capture, nowSec, snapshot: decodeSuiClmmSnapshot(capture, nowSec, { poolId: fixture.poolId }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Sui CLMM actual pinned state and independent exact-in outputs", () => {
  it.each(pinned)("reproduces the full two-direction request grid at $fixture.poolId", ({ fixture, snapshot }) => {
    for (let i = 0; i < fixture.requests.length; i++) {
      const request = fixture.requests[i];
      const independent = fixture.expected[i].remote;
      const coin = request.aToB ? snapshot.pool.coinA : snapshot.pool.coinB;
      if (independent.exceeded) {
        expect(() => quoteSuiClmmExactIn(snapshot, coin, BigInt(request.amountIn))).toThrow("sui-clmm-liquidity-exhausted");
      } else {
        const quote = quoteSuiClmmExactIn(snapshot, coin, BigInt(request.amountIn));
        expect(quote.amountOut.toString()).toBe(independent.amountOut);
        expect(quote.feeAmount.toString()).toBe(independent.feeAmount);
        expect(quote.sqrtPriceAfter.toString()).toBe(independent.sqrtPriceAfter);
        expect(quote.checkpoint).toBe(snapshot.checkpoint);
      }
    }
  });

  it.each(inspections)("decodes the actual pool Move return without treating epoch inspection as a checkpoint pin: $poolId", (receipt) => {
    const source = pinned.find((row) => row.fixture.poolId === receipt.poolId)!;
    const quote = decodeSuiClmmInspectResults(receipt.response, source.snapshot, [{ ...receipt.request, amountIn: BigInt(receipt.request.amountIn) }])[0];
    expect(quote.amountOut.toString()).toBe(source.fixture.expected[0].remote.amountOut);
    expect(quote.feeAmount.toString()).toBe(source.fixture.expected[0].remote.feeAmount);
    expect(quote.checkpointBound).toBe(false);
  });

  it("allocates the protocol's share from the fee, not as an additional input charge", () => {
    const source = pinned.find((row) => row.snapshot.pool.family === "bluefin" && row.snapshot.ticks.length === 2)!;
    const quote = quoteSuiClmmExactIn(source.snapshot, source.snapshot.pool.coinA, BigInt(source.fixture.requests[0].amountIn));
    expect(quote.steps).toBe(1);
    expect(quote.protocolFeeAmount).toBe(quote.feeAmount * BigInt(source.snapshot.pool.protocolFeeRate) / 1_000_000n);
    const receipt = inspections.find((row) => row.poolId === source.fixture.poolId)!;
    const bytes = receipt.response.results[0].returnValues[0][0] as number[];
    let protocolFee = 0n;
    for (let i = 57; i >= 50; i--) protocolFee = protocolFee << 8n | BigInt(bytes[i]);
    expect(quote.protocolFeeAmount).toBe(protocolFee);
  });

  it("does not fabricate a zero quote from an empty liquidity book", () => {
    const snapshot = pinned[0].snapshot;
    const empty = { ...snapshot, pool: { ...snapshot.pool, liquidity: 0n, tickCount: 0 }, ticks: [] };
    expect(() => quoteSuiClmmExactIn(empty, snapshot.pool.coinA, 1_000n)).toThrow("sui-clmm-liquidity-exhausted");
  });

  it("rejects foreign input types and amount overflow instead of quoting the other coin", () => {
    const snapshot = pinned[0].snapshot;
    expect(() => quoteSuiClmmExactIn(snapshot, "0x2::sui::SUI", 1_000n)).toThrow("sui-clmm-input-identity-mismatch");
    expect(() => quoteSuiClmmExactIn(snapshot, snapshot.pool.coinA, 1n << 64n)).toThrow("sui-clmm-input-outside-u64");
  });
});

describe("checkpoint and complete native-identity admission", () => {
  it("accepts the exact freshness boundary and rejects one second later or a future checkpoint", () => {
    const { capture, fixture, nowSec } = pinned[0];
    expect(decodeSuiClmmSnapshot(capture, nowSec + DEX_MEASURED_FRESHNESS_MAX_SEC, { poolId: fixture.poolId }).checkpoint).toBe(String(fixture.capture.checkpoint.sequenceNumber));
    expect(() => decodeSuiClmmSnapshot(capture, nowSec + DEX_MEASURED_FRESHNESS_MAX_SEC + 1, { poolId: fixture.poolId })).toThrow("sui-stale-or-future-checkpoint");
    expect(() => decodeSuiClmmSnapshot(capture, nowSec - 1, { poolId: fixture.poolId })).toThrow("sui-stale-or-future-checkpoint");
  });

  it("requires finalized transactions at or before the requested checkpoint", () => {
    const { fixture, nowSec } = pinned[0];
    const later = structuredClone(fixture.capture);
    later.transactions[0].checkpoint = String(BigInt(later.checkpoint.sequenceNumber) + 1n);
    expect(() => decodeSuiClmmSnapshot(later as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-object-newer-than-checkpoint");
    const absent = structuredClone(fixture.capture);
    const unfinalized: { checkpoint?: string } = absent.transactions[0];
    delete unfinalized.checkpoint;
    expect(() => decodeSuiClmmSnapshot(absent as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-transaction-not-finalized");
    expect(fixture.capture.transactions.some((transaction) => "source" in transaction && transaction.source === "sui-graphql-archive")).toBe(true);
  });

  it("rejects a pool changed between reads and any missing tick object", () => {
    const { fixture, nowSec } = pinned[0];
    const changed = structuredClone(fixture.capture);
    changed.finalObjects[0].data.version = String(BigInt(changed.finalObjects[0].data.version) + 1n);
    expect(() => decodeSuiClmmSnapshot(changed as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-object-changed-during-capture");
    const missing = structuredClone(fixture.capture);
    missing.objects.pop(); missing.finalObjects.pop();
    expect(() => decodeSuiClmmSnapshot(missing as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-incomplete-tick-census");
  });

  it("rejects package, currency and dynamic-field ownership mismatches", () => {
    const { fixture, nowSec, capture } = pinned[0];
    const foreign = structuredClone(fixture.capture);
    foreign.objects[0].data.content.type = foreign.objects[0].data.content.type.replace("::pool::Pool", "::not_pool::Pool");
    expect(() => decodeSuiClmmSnapshot(foreign as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-pool-identity-mismatch");
    const foreignPackage = structuredClone(fixture.capture);
    foreignPackage.objects[0].data.content.type = foreignPackage.objects[0].data.content.type.replace(/^0x[a-f0-9]{64}/, `0x${"f".repeat(64)}`);
    expect(() => decodeSuiClmmSnapshot(foreignPackage as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-pool-identity-mismatch");
    expect(() => decodeSuiClmmSnapshot(capture, nowSec, { poolId: fixture.poolId, coinA: "0x2::sui::SUI" })).toThrow("sui-coin-identity-mismatch");
    const wrongOwner = structuredClone(fixture.capture);
    const tick = wrongOwner.objects.find((object) => "ObjectOwner" in object.data.owner);
    if (!tick || !("ObjectOwner" in tick.data.owner)) throw new Error("fixture-tick-owner-missing");
    tick.data.owner.ObjectOwner = fixture.poolId;
    expect(() => decodeSuiClmmSnapshot(wrongOwner as SuiClmmCapture, nowSec, { poolId: fixture.poolId })).toThrow("sui-tick-owner-mismatch");
  });

  it("rejects an independent quote that read a different pool object version", () => {
    const receipt = structuredClone(inspections[0]);
    const snapshot = pinned.find((row) => row.fixture.poolId === receipt.poolId)!.snapshot;
    receipt.response.effects.sharedObjects[0].version++;
    expect(() => decodeSuiClmmInspectResults(receipt.response, snapshot, [{ ...receipt.request, amountIn: BigInt(receipt.request.amountIn) }])).toThrow("sui-inspect-state-changed");
  });
});

describe("Sui retained discovery and shadow scope", () => {
  it("joins exact native object identities across Cetus discovery aliases without inventing UUID joins", () => {
    const { snapshot } = pinned[0];
    const identity = buildPoolIdentity({ chain: "Sui", protocol: "cetus-clmm", poolAddressOrId: snapshot.pool.poolId.toUpperCase().replace("0X", "0x"), tokenAddresses: [snapshot.pool.coinA, snapshot.pool.coinB], poolType: "generic" });
    const discovery = buildPoolIdentity({ chain: "sui", protocol: "cetus", poolAddressOrId: `sui:${snapshot.pool.poolId}`, tokenAddresses: [snapshot.pool.coinB, snapshot.pool.coinA], poolType: "cg-amm" });
    expect(identity.exactPoolKey).toBe(`sui:${snapshot.pool.poolId}`);
    expect(identity.exactPoolKey).toBe(discovery.exactPoolKey);
    expect(identity.derivedMatchKey).toBe(discovery.derivedMatchKey);
    expect(buildPoolIdentity({ chain: "sui", protocol: "cetus-clmm", poolAddressOrId: "f19cd3ab-0000-0000-0000-18d177ea632f", tokenAddresses: [snapshot.pool.coinA, snapshot.pool.coinB] }).exactPoolKey).toBeNull();
    expect(normalizeProtocol("bluefin-spot")).toBe("bluefin");
    expect(normalizeProtocol("bluefin-perps")).toBe("bluefin-perps");
  });

  it("normalizes only the Move package address while preserving case-sensitive module and currency names", () => {
    const { snapshot } = pinned[0];
    const input = { chain: "sui", protocol: "cetus", tokenAddresses: [snapshot.pool.coinA, snapshot.pool.coinB] };
    const identity = buildPoolIdentity(input);
    const parts = snapshot.pool.coinA.split("::");
    const addressAlias = `${parts[0].toUpperCase().replace("0X", "0x")}::${parts[1]}::${parts[2]}`;
    expect(buildPoolIdentity({ ...input, tokenAddresses: [addressAlias, snapshot.pool.coinB] }).derivedMatchKey).toBe(identity.derivedMatchKey);
    expect(buildPoolIdentity({ ...input, tokenAddresses: [`${parts[0]}::${parts[1]}::${parts[2].toLowerCase()}`, snapshot.pool.coinB] }).derivedMatchKey).not.toBe(identity.derivedMatchKey);
  });

  it("keeps native targets shadow-only and unresolved fingerprints unresolved", () => {
    const { snapshot } = pinned[0];
    const input = { identity: { chainNorm: "sui", protocol: "cetus", pool: { pool: snapshot.pool.poolId, underlyingTokens: [snapshot.pool.coinA, snapshot.pool.coinB] } } } as DexExecutionTargetFactoryInput;
    expect(buildSuiClmmRegisteredExecutionTarget(input)).toEqual({ executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } });
    input.identity.pool.pool = `fp:sui:cetus:${snapshot.pool.coinA}:${snapshot.pool.coinB}`;
    expect(buildSuiClmmRegisteredExecutionTarget(input)?.executionCapabilityGate?.reason).toBe("target-unresolved");
    for (const profile of ["cetus-clmm-exact-v1", "bluefin-spot-clmm-exact-v1"]) {
      const registration = getDexExecutionCapabilityRegistration(profile)!;
      expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: profile, chain: "sui" }, registration)).toBe(false);
    }
  });

  it("rotates Cetus directions independently and excludes retired Bluefin collection", () => {
    const pool = pinned[0].fixture.poolId;
    const other = pinned[1].fixture.poolId;
    const rows = [
      { pool_id: `sui:${pool}`, stablecoin_id: "usdy-ondo-finance", tvl_usd: 100, project: "cetus" },
      { pool_id: `sui:${pool}`, stablecoin_id: "usdy-ondo-finance", tvl_usd: 90, project: "cetus-clmm" },
      { pool_id: `sui:${pool}`, stablecoin_id: "usdc-circle", tvl_usd: 80, project: "cetus" },
      { pool_id: `sui:${other}`, stablecoin_id: "usdsui-sui", tvl_usd: 70, project: "bluefin" },
      { pool_id: `fp:sui:cetus:${pool}`, stablecoin_id: "usdy-ondo-finance", tvl_usd: 1000, project: "cetus" },
    ];
    expect(selectSuiShadowPools(rows, null).selected.map((row) => row.stablecoin_id)).toEqual(["usdy-ondo-finance", "usdc-circle"]);
    expect(selectSuiShadowPools(rows, "1").selected.map((row) => row.stablecoin_id)).toEqual(["usdc-circle"]);
    expect(selectSuiShadowPools(rows, "2").total).toBe(2);
    expect(selectSuiShadowPools(rows.filter((row) => row.project === "bluefin"), null).selected).toEqual([]);
  });
});

describe("Sui actual shadow producer packets", () => {
  const pinnedPool = pinned.find(({ fixture }) => fixture.poolId === shadowInspections.poolId)!;
  const producerInput = {
    snapshot: pinnedPool.snapshot, stablecoinId: "usdc-circle",
    coinTypeIn: pinnedPool.snapshot.pool.coinA, inputDecimals: 6, inputPriceUsd: 1,
    retainedTvlUsd: 200_000, generationId: "sui-clmm-shadow-source-fixture",
  };

  it("executes the real producer ladder against captured native Move receipts without claiming checkpoint execution", async () => {
    let inspectionIndex = 0;
    const rpc: SuiRpc = async (method, params) => {
      if (method === "sui_multiGetObjects" && Array.isArray(params[0])) {
        return params[0].map((id) => pinnedPool.capture.finalObjects.find((object) => suiObject(object).objectId === id));
      }
      if (method === "sui_devInspectTransactionBlock") return shadowInspections.responses[inspectionIndex++];
      throw new Error(`unexpected-fixture-rpc:${method}`);
    };
    const sample = await observeSuiClmmShadowPool({ ...producerInput, rpc });
    expect(inspectionIndex).toBe(2);
    expect(sample.quotes.map((quote) => quote.amountIn)).toEqual(shadowInspections.requests.map((request) => request.amountIn));
    expect(sample.quotes.map((quote) => quote.amountOut)).toEqual(shadowInspections.expected.map((quote) => quote.amountOut));
    expect(sample.quotes.every((quote) => quote.independentAgreement === true)).toBe(true);
    expect(sample.independentCheck).toBe("stationary-object-set");
    expect(sample.checkpoint).toBe(pinnedPool.snapshot.checkpoint);
    expect(sample.references).toEqual(pinnedPool.snapshot.references);
    expect(sample.tickCensusComplete).toBe(true);
    expect(sample.checkpointBoundInspection).toBe(false);
    expect(sample.scoreEligible).toBe(false);
  });

  it("retains a named unavailable inspection without fabricating agreement or score admission", async () => {
    const rpc: SuiRpc = async () => { throw new Error("sui-inspect-budget-exhausted"); };
    const sample = await observeSuiClmmShadowPool({ ...producerInput, rpc });
    expect(sample.independentCheck).toBe("failed");
    expect(sample.independentCheckReason).toBe("sui-inspect-budget-exhausted");
    expect(sample.quotes.every((quote) => quote.independentAgreement === null)).toBe(true);
    expect(sample.quotes[0].amountOut).toBe(shadowInspections.expected[0].amountOut);
    expect(sample.scoreEligible).toBe(false);
  });

  it("rejects an unavailable trusted reference before any independent request", async () => {
    const rpc: SuiRpc = vi.fn();
    await expect(observeSuiClmmShadowPool({ ...producerInput, rpc, inputPriceUsd: 0 })).rejects.toThrow("sui-trusted-input-reference-unavailable");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("Sui bounded archival checkpoint transport", () => {
  function oneRequestBudget(timeoutMs = 1_000): DexRequestBudget {
    let remaining = 1;
    return {
      maxRequests: 1, deadlineMs: Date.now() + timeoutMs,
      get remainingRequests() { return remaining; },
      tryConsume(count = 1) {
        if (count > remaining) return false;
        remaining -= count;
        return true;
      },
    };
  }

  it("parses actual archival checkpoint provenance and refuses a second unbudgeted request", async () => {
    const archived = pinned[0].fixture.capture.transactions.find((transaction) => "source" in transaction && transaction.source === "sui-graphql-archive");
    if (!archived || !("checkpointDigest" in archived) || typeof archived.checkpointDigest !== "string") throw new Error("fixture-archival-proof-missing");
    const response = new Response(JSON.stringify({ data: { t0: {
      digest: archived.digest, effects: { checkpoint: { sequenceNumber: archived.checkpoint, digest: archived.checkpointDigest } },
    } } }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const resolver = createSuiTransactionCheckpointResolver({ signal: new AbortController().signal, budget: oneRequestBudget() });
    await expect(resolver([archived.digest])).resolves.toEqual([{
      digest: archived.digest, checkpoint: String(archived.checkpoint), checkpointDigest: archived.checkpointDigest, source: "sui-graphql-archive",
    }]);
    expect(response.bodyUsed).toBe(true);
    await expect(resolver([archived.digest])).rejects.toThrow("sui-archive-budget-exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels an over-cap archival response instead of parsing partial provenance or retrying", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
      headers: { "content-length": String(256 * 1024 + 1) },
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const resolver = createSuiTransactionCheckpointResolver({ signal: new AbortController().signal, budget: oneRequestBudget() });
    await expect(resolver([pinned[0].fixture.capture.transactions[0].digest])).rejects.toThrow("sui-archive-transport-failed");
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

const usdy = fixtures.fixtures[0];
const buck = fixtures.fixtures[3];
const nowSec = Math.floor(Number(usdy.capture.checkpoint.timestampMs) / 1000);
const rows = [
  { pool_id: usdy.poolId, stablecoin_id: "usdy-ondo-finance", tvl_usd: 200_000, project: "cetus" },
  { pool_id: buck.poolId, stablecoin_id: "buck-bucket-protocol", tvl_usd: 100_000, project: "cetus" },
];
const env = { DWELLIR_API_KEY: "test-header-only-key" };

function asset(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, symbol: id, pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: id === "usdy-ondo-finance" ? 1.15 : 0.997, priceSource: "coingecko", priceConfidence: "single-source",
    priceObservedAt: nowSec, priceUpdatedAt: nowSec, priceObservedAtMode: "upstream",
    circulating: { peggedUSD: 1_000_000 }, chainCirculating: {}, chains: ["Sui"], ...overrides };
}

function database(assets: ReturnType<typeof asset>[] | null, selected = rows, updatedAt = nowSec) {
  return mockD1([
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: assets == null ? [] : [{ value: JSON.stringify({ peggedAssets: assets }), updated_at: updatedAt }] },
    { match: "FROM cache WHERE key = ?", rows: [] },
    { match: "FROM dex_source_pagination_state", rows: [] },
    { match: "FROM dex_liquidity dl, json_each", rows: selected },
    { match: "INSERT INTO dex_source_pagination_state", rows: [], runMeta: { changes: 1 } },
    { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  ]);
}

describe("Sui shadow diagnostic price preflight and reasons", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000));

  it.each(["high", "single-source"])("attempts both real retained pools with fresh %s published prices", async (confidence) => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
    const db = database(rows.map((row) => asset(row.stablecoin_id, { priceConfidence: confidence })));
    const summary = await collectSuiClmmShadowQuotes({ db, env });
    expect(summary).toMatchObject({ attempted: 2, persisted: 0, failed: 2, requests: 2, scoreEligible: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(summary.reason).toMatch(/^sui-/);
    expect(summary.reason).not.toBe("sui-trusted-input-reference-unavailable");
  });

  it.each([
    { name: "missing cache", assets: null },
    { name: "missing price", assets: [asset(rows[0].stablecoin_id, { price: null })] },
    { name: "stale observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1 })] },
    { name: "future observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: nowSec + 1 })] },
    { name: "missing observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: null, priceUpdatedAt: null })] },
    { name: "missing source", assets: [asset(rows[0].stablecoin_id, { priceSource: null })] },
    { name: "low confidence", assets: [asset(rows[0].stablecoin_id, { priceConfidence: "low" })] },
    { name: "nominal reference", assets: [asset(rows[0].stablecoin_id, { priceSource: "protocol-par", priceObservedAtMode: "nominal_reference" })] },
  ])("rejects $name without any RPC request", async ({ assets }) => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db: database(assets, rows.slice(0, 1)), env });
    expect(summary).toMatchObject({ attempted: 1, persisted: 0, failed: 1, requests: 0,
      reason: "sui-trusted-input-reference-unavailable", lastFailureReason: "sui-trusted-input-reference-unavailable" });
    expect(summary.failures).toEqual([`${usdy.poolId}:sui-trusted-input-reference-unavailable`]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1, nowSec + 1])("rejects a stale or future published cache generation (%s)", async (updatedAt) => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db: database([asset(rows[0].stablecoin_id)], rows.slice(0, 1), updatedAt), env });
    expect(summary).toMatchObject({ requests: 0, reason: "sui-trusted-input-reference-unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists diagnostic quote inputs and their source, clock, confidence and freshness budget", async () => {
    const db = database([asset(rows[0].stablecoin_id, { priceObservedAt: null, priceUpdatedAt: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC })], rows.slice(0, 1));
    vi.spyOn(stateReader, "fetchSuiClmmCapture").mockResolvedValue(usdy.capture as stateReader.SuiClmmCapture);
    const inspection = vi.spyOn(independentQuote, "inspectSuiClmmQuotes");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db, env });
    expect(summary).toMatchObject({ attempted: 1, persisted: 1, failed: 0, scoreEligible: false,
      independentCheckReason: "sui-grpc-inspection-unsupported" });
    expect(inspection).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const write = db.getHistory().find(({ sql }) => sql.includes("INSERT INTO cache"));
    expect(write).toBeDefined();
    const sample = SuiClmmShadowHistorySchema.parse(JSON.parse(String(write!.binds[1]))).samples[0];
    expect(sample.inputPriceReference).toEqual({ source: "coingecko", confidence: "single-source",
      observedAtSec: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, cacheUpdatedAtSec: nowSec, maxAgeSec: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC });
    expect(sample.inputPriceUsd).toBe(1.15);
    expect(sample.quotes.length).toBeGreaterThan(0);
    expect(sample.independentCheck).toBe("failed");
    expect(sample.independentCheckReason).toBe("sui-grpc-inspection-unsupported");
    expect(sample.quotes.every((quote) => quote.independentAgreement === null)).toBe(true);
    expect(sample.scoreEligible).toBe(false);
    const historical = { ...sample, inputPriceReference: undefined };
    expect(SuiClmmShadowHistorySchema.safeParse({ schemaVersion: "sui-clmm-shadow-v1", samples: [historical] }).success).toBe(true);
  });

  it("counts and names a pool whose in-flight read the runtime fence aborted", async () => {
    // Compress the collector's wall-clock fence: the read is still stopped by
    // the same AbortSignal.timeout path production uses, after one request.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(Math.min(ms, 150)));
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) return reject(new Error("sui-test-fetch-signal-missing"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const summary = await collectSuiClmmShadowQuotes({
      db: database([asset(rows[0].stablecoin_id)], rows.slice(0, 1)),
      env,
    });

    expect(summary).toMatchObject({
      attempted: 1, persisted: 0, failed: 1, requests: 1, budgetExhausted: false,
      reason: "sui-runtime-fence-exceeded", scoreEligible: false,
    });
    expect(summary.persisted + summary.failed).toBe(summary.attempted);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.startsWith(`${rows[0].pool_id}:sui-`)).toBe(true);
  }, 5_000);

  it("retains bounded first/last reason codes through cron metadata compaction", async () => {
    vi.spyOn(stateReader, "fetchSuiClmmCapture")
      .mockRejectedValueOnce(new Error("sui-grpc-http-404"))
      .mockRejectedValueOnce(new Error("sui-object-unavailable"));
    const summary = await collectSuiClmmShadowQuotes({ db: database(rows.map((row) => asset(row.stablecoin_id))), env });
    expect(summary).toMatchObject({ reason: "sui-grpc-http-404", lastFailureReason: "sui-object-unavailable" });
    const compacted = compactCronMetadataForPersistence(JSON.stringify({ suiShadow: summary, payload: "x".repeat(20_000) }), undefined, "sync-cl-exit-depth");
    expect(compacted.compacted).toBe(true);
    expect(JSON.parse(compacted.metadata!).diagnostics.suiShadow).toMatchObject({ reason: "sui-grpc-http-404",
      lastFailureReason: "sui-object-unavailable", failuresCount: 2, scoreEligible: false });
  });
});

const headers = { "content-type": "application/grpc-web+proto" };
const signal = () => new AbortController().signal;
const encode = (value: string) => new TextEncoder().encode(value);
const binary = (base64: string) => Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
function frame(flag: number, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.length + 5);
  result[0] = flag; new DataView(result.buffer).setUint32(1, body.length); result.set(body, 5);
  return result;
}
function unary(payload: Uint8Array, trailer = "grpc-status: 0\r\n"): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...frame(0, payload), ...frame(128, encode(trailer))]);
}
function budget(maxRequests = 64, timeoutMs = 45_000): DexRequestBudget {
  let used = 0;
  return { maxRequests, deadlineMs: Date.now() + timeoutMs, get remainingRequests() { return maxRequests - used; },
    tryConsume(count = 1) { if (count > maxRequests - used) return false; used += count; return true; } };
}
function client(options: { budget?: DexRequestBudget; onResponse?: () => void; signal?: AbortSignal } = {}) {
  return createSuiClmmGrpc({ url: "https://rpc.example.invalid", headers: { "X-Api-Key": "header-only-test-key" },
    signal: options.signal ?? signal(), budget: options.budget ?? budget(), onResponse: options.onResponse ?? vi.fn() });
}

describe("Sui binary gRPC-web live wire regression", () => {
  it("replays the actual collector through quote and diagnostic D1 persistence, including pruned ancestry", async () => {
    const { sample } = receipts;
    vi.spyOn(Date, "now").mockReturnValue(sample.observedAtSec * 1000);
    let index = 0;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const receipt = receipts.responses[index++];
      expect(new URL(String(url)).pathname).toBe(receipt.path);
      if (receipt.path !== "/graphql") {
        const sent = new Headers(init?.headers);
        expect(sent.get("X-Api-Key")).toBe("header-only-test-key");
        expect(sent.get("content-type")).toBe("application/grpc-web+proto");
        expect(sent.get("x-grpc-web")).toBe("1");
        expect(init?.redirect).toBe("manual");
      }
      return new Response(binary(receipt.bodyBase64), { status: receipt.status, headers: { "content-type": receipt.contentType! } });
    });
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [{ updated_at: sample.inputPriceReference.cacheUpdatedAtSec,
        value: JSON.stringify({ peggedAssets: [{ id: sample.stablecoinId, name: "Bucket", symbol: "BUCK", pegType: "peggedUSD",
          pegMechanism: "crypto-backed", price: sample.inputPriceUsd, priceSource: sample.inputPriceReference.source,
          priceConfidence: sample.inputPriceReference.confidence, priceObservedAt: sample.inputPriceReference.observedAtSec,
          priceObservedAtMode: "upstream", circulating: { peggedUSD: 1_000_000 }, chainCirculating: {}, chains: ["Sui"] }] }) }] },
      { match: "FROM cache WHERE key = ?", rows: [] },
      { match: "FROM dex_source_pagination_state", rows: [] },
      { match: "FROM dex_liquidity dl, json_each", rows: [{ pool_id: `sui:${sample.poolId}`, stablecoin_id: sample.stablecoinId, tvl_usd: 1_084_307, project: "cetus" }] },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO dex_source_pagination_state", rows: [], runMeta: { changes: 1 } },
    ]);
    const summary = await collectSuiClmmShadowQuotes({ db, env: { DWELLIR_API_KEY: "header-only-test-key" } });
    expect(summary).toMatchObject({ attempted: 1, persisted: 1, failed: 0, requests: 8, budgetExhausted: false,
      scoreEligible: false, independentCheckReason: "sui-grpc-inspection-unsupported" });
    expect(index).toBe(receipts.responses.length);
    expect(fetcher).toHaveBeenCalledTimes(8);
    const write = db.getHistory().find(({ sql }) => sql.includes("INSERT INTO cache"))!;
    const stored = SuiClmmShadowHistorySchema.parse(JSON.parse(String(write.binds[1]))).samples[0];
    expect(stored).toEqual(sample);
    expect(stored.quotes[2]).toMatchObject({ amountOut: null, reason: "sui-clmm-liquidity-exhausted", independentAgreement: null });
    expect(db.getHistory().some(({ sql }) => /INSERT INTO (dex_execution|dex_liquidity)/.test(sql))).toBe(false);
  });

  it("rejects transaction errors other than explicit NOT_FOUND rather than guessing ancestry", async () => {
    // BatchGetTransactionsResponse.transactions[0].error.code = INTERNAL.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from([10, 4, 18, 2, 8, 13])), { headers }));
    await expect(client()("sui_multiGetTransactionBlocks", [["digest"]])).rejects.toThrow("sui-grpc-transaction-read-failed");
  });

  it("keeps an explicit pruned transaction unavailable for the existing archive resolver", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from([10, 4, 18, 2, 8, 5])), { headers }));
    await expect(client()("sui_multiGetTransactionBlocks", [["digest"]])).resolves.toEqual([{ digest: "digest" }]);
  });

  it("names unsupported inspection before consuming a request or claiming agreement", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const requests = budget();
    await expect(client({ budget: requests })("sui_devInspectTransactionBlock", [])).rejects.toThrow("sui-grpc-inspection-unsupported");
    expect(requests.remainingRequests).toBe(64);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Sui gRPC-web framing and trust boundary", () => {
  it.each([
    { name: "missing trailer", body: frame(0, new Uint8Array()), reason: "missing-trailer" },
    { name: "truncated header", body: Uint8Array.from([0, 0]), reason: "invalid-frame" },
    { name: "truncated payload", body: Uint8Array.from([0, 0, 0, 0, 10]), reason: "truncated-frame" },
    { name: "compressed message", body: frame(1, new Uint8Array()), reason: "invalid-frame" },
    { name: "two messages", body: Uint8Array.from([...frame(0, new Uint8Array()), ...unary(new Uint8Array())]), reason: "invalid-frame" },
    { name: "duplicate status", body: unary(new Uint8Array(), "grpc-status: 0\r\ngrpc-status: 0\r\n"), reason: "invalid-trailer" },
    { name: "malformed status", body: unary(new Uint8Array(), "grpc-status: nope\r\n"), reason: "invalid-trailer" },
    { name: "error status", body: frame(128, encode("grpc-status: 13\r\ngrpc-message: secret upstream details\r\n")), reason: "status-13" },
    { name: "message missing", body: frame(128, encode("grpc-status: 0\r\n")), reason: "missing-message" },
    { name: "bytes after trailer", body: Uint8Array.from([...unary(new Uint8Array()), 0]), reason: "invalid-frame" },
  ])("rejects $name", ({ body, reason }) => {
    expect(() => decodeSuiGrpcWebUnary(body)).toThrow(`sui-grpc-${reason}`);
  });

  it.each([
    [10, 255, 255, 255, 255, 127], // Claimed nested-message length exceeds intake.
    [0], // Invalid field zero.
    [8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2], // uint64 overflow.
  ])("rejects malformed protobuf (%j)", async (...payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from(payload)), { headers }));
    await expect(client()("sui_getObject", ["0x1"])).rejects.toThrow(/^sui-grpc-/);
  });
});

describe("Sui gRPC shared request/credit and connection limits", () => {
  it("consumes an HTTP failure once, meters its response and refuses an unbudgeted retry", async () => {
    const response = new Response("upstream details", { status: 404 });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const requests = budget(1);
    const rpc = client({ onResponse, budget: requests });
    await expect(rpc("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-http-404");
    await expect(rpc("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    expect(response.bodyUsed).toBe(true);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires the binary gRPC-web content type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not protobuf", { headers: { "content-type": "application/json" } }));
    await expect(client()("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-content-type-mismatch");
  });

  it("cancels and meters oversized bodies without retrying", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { ...headers, "content-length": String(2 * 1024 * 1024 + 1) } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    await expect(client({ onResponse })("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-transport-failed");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active through body consumption and rejects a concurrent read", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const rpc = client({ budget: budget(2, 20), onResponse });
    const pending = rpc("sui_getObject", ["0x1"]).catch((error: unknown) => error);
    await expect(rpc("sui_getObject", ["0x2"])).rejects.toThrow("sui-rpc-concurrent-request");
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toMatchObject({ message: "sui-grpc-transport-failed" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("does not start a request after cancellation or deadline", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController(); controller.abort();
    await expect(client({ signal: controller.signal })("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    await expect(client({ budget: budget(2, -1) })("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
