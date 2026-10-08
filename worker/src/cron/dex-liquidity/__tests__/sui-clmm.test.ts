import { describe, expect, it, vi, afterEach } from "vitest";
import fixtures from "./fixtures/sui-clmm-checkpoints.json";
import inspections from "./fixtures/sui-clmm-inspections.json";
import shadowInspections from "./fixtures/sui-clmm-shadow-inspections.json";
import { DEX_MEASURED_FRESHNESS_MAX_SEC, type DexRequestBudget } from "@shared/types/measured-execution";
import { isDexExecutionProfileAdmittedForScoring, getDexExecutionCapabilityRegistration } from "@shared/lib/p4-exit-route-capability-policy";
import { decodeSuiClmmSnapshot, createSuiClmmRpc, suiObject, type SuiClmmCapture, type SuiRpc } from "../sui/state-reader";
import { quoteSuiClmmExactIn } from "../sui/clmm-quote";
import { createSuiTransactionCheckpointResolver } from "../sui/archival-checkpoints";
import { decodeSuiClmmInspectResults } from "../sui/independent-quote";
import { buildPoolIdentity } from "../pool-identity";
import { normalizeProtocol } from "../pool-normalization";
import { buildSuiClmmRegisteredExecutionTarget } from "../execution-targets/sui-clmm";
import { selectSuiShadowPools, observeSuiClmmShadowPool } from "../sui/shadow";
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

  it("covers in-range execution and real multi-tick crossings rather than a marginal-only model", () => {
    let inRange = 0;
    let multiTick = 0;
    for (const { fixture, snapshot } of pinned) for (let i = 0; i < fixture.requests.length; i++) {
      if (fixture.expected[i].remote.exceeded) continue;
      const request = fixture.requests[i];
      const quote = quoteSuiClmmExactIn(snapshot, request.aToB ? snapshot.pool.coinA : snapshot.pool.coinB, BigInt(request.amountIn));
      if (quote.crossedTicks === 0) inRange++;
      if (quote.crossedTicks >= 2) multiTick++;
    }
    expect(inRange).toBeGreaterThan(0);
    expect(multiTick).toBeGreaterThan(0);
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

  it("never fetches when the shared request budget is exhausted and consumes responses serially", async () => {
    const signal = new AbortController().signal;
    let remaining = 1;
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "330486099" })));
    const rpc = createSuiClmmRpc({ url: "https://example.invalid", signal, budget: { maxRequests: 1, deadlineMs: Date.now() + 1000, get remainingRequests() { return remaining; }, tryConsume() { if (!remaining) return false; remaining--; return true; } } });
    expect(await rpc("sui_getLatestCheckpointSequenceNumber", [])).toBe("330486099");
    await expect(rpc("sui_getLatestCheckpointSequenceNumber", [])).rejects.toThrow("sui-rpc-budget-exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
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

describe("Sui resilient bounded provider transport", () => {
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

  it("consumes an HTTP failure without retrying outside the request or credit budget", async () => {
    const response = new Response(JSON.stringify({ id: 1, error: { code: -32000, message: "provider unavailable" } }), { status: 503 });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const budget = oneRequestBudget();
    const rpc = createSuiClmmRpc({ url: "https://example.invalid", signal: new AbortController().signal, budget, onResponse });
    await expect(rpc("sui_getObject", [])).rejects.toThrow("sui-rpc-response-failed:sui_getObject");
    expect(response.bodyUsed).toBe(true);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.remainingRequests).toBe(0);
  });

  it("records a received RPC response even when its oversized body is rejected and cancelled", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const budget = oneRequestBudget();
    const rpc = createSuiClmmRpc({ url: "https://example.invalid", signal: new AbortController().signal, budget, onResponse });
    await expect(rpc("sui_multiGetObjects", [])).rejects.toThrow("sui-rpc-transport-failed:sui_multiGetObjects");
    expect(cancelled).toBe(true);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.remainingRequests).toBe(0);
  });

  it("keeps the deadline active through an unfinished body and rejects overlapping RPC reads", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const rpc = createSuiClmmRpc({ url: "https://example.invalid", signal: new AbortController().signal, budget: oneRequestBudget(20) });
    const pending = rpc("sui_getObject", []).catch((error: unknown) => error);
    await expect(rpc("sui_getCheckpoint", [])).rejects.toThrow("sui-rpc-concurrent-request");
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toMatchObject({ message: "sui-rpc-transport-failed:sui_getObject" });
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

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
