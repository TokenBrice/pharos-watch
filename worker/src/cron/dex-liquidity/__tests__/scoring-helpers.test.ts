import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  accumulateGlobalAggregate,
  aggregateProtocolSources,
  applyPoolVolumeEligibility,
  classifyCoverage,
  collapseDuplicateObservations,
  buildDexPriceObservationsFromRetainedPools,
  filterRetainedPools,
  quarantineProtocolTvlOutliers,
  summarizeRetainedPoolVolume,
  type GlobalPoolAggregateEntry,
} from "../scoring-helpers";
import { DEX_DEAD_POOL_TVL_MIN_USD, DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { computeLiquidityScore, initLiquidityFallbackCounters } from "../pool-helpers";
import { isPlausibleDexObservationPrice } from "../price-sanity";
import type { LiquiditySourceMixByFamily } from "../types";
import { makeObs, makePool, scorePoolGraph, withCompleteVolume } from "./scoring-test-builders";
import { captureObservedPoolPrices, measurePriceRefreshDemand, refreshPoolPrices } from "../price-refresh";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import * as cg from "../../../lib/coingecko-onchain";
import * as breaker from "../../../lib/circuit-breaker";
import { createSlotDeadline } from "../../../lib/cron-timeouts";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import type { DexPriceObs, PoolEntry } from "../types";

describe("source-stage exact-pool price refresh", () => {
  const now = 1_800_000_000;
  const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
  const token = (id: string, chain = "ethereum") => WORKER_TRACKED_META_BY_ID.get(id)!.contracts!.find((row) => row.chain === chain)!.address;
  const pool = (i: number, overrides: Partial<PoolEntry> = {}) => makePool({
    chain: "ethereum", poolId: `ethereum:${address(i)}`, price: 0.99, priceObservedAt: now - 6 * 3600,
    tvlUsd: 100_000, priceEvidenceTvlUsd: 30_000,
    volumeReading: { volume24hUsd: 1_000_000, volume7dUsd: 7_000_000, observedAtSec: now - 30 },
    extra: { measurement: { priceMeasured: true }, balanceRatio: 0.9, effectiveTvl: 90_000,
      executionCapabilityGate: { family: "measured-execution", reason: "budget-deferred" }, measuredExecutionPhysicalPoolId: address(i) }, ...overrides,
  });
  function graph(pools: PoolEntry[], quotePools: PoolEntry[] = []) {
    return new Map([
      ["usdc-circle", { stablecoinId: "usdc-circle", symbol: "USDC", pools }],
      ["usdt-tether", { stablecoinId: "usdt-tether", symbol: "USDT", pools: quotePools }],
    ]);
  }
  const context = (metrics: ReturnType<typeof graph>) => ({ metrics, primaryPrices: new Map([...metrics.keys()].map((id) => [id, 1])), protocolTvlCaps: new Map<string, number>(), registryEvaluatedAtSec: now });
  function row(i: number, attributes = {}, relationships = {}): cg.CgPool {
    return {
      id: `eth_${address(i)}`, type: "pool",
      attributes: { address: address(i), name: "USDC / USDT", reserve_in_usd: "80000", base_token_price_usd: "1.002", quote_token_price_usd: "0.998", ...attributes },
      relationships: {
        base_token: { data: { id: `eth_${token("usdc-circle")}`, type: "token" } },
        quote_token: { data: { id: `eth_${token("usdt-tether")}`, type: "token" } },
        dex: { data: { id: "uniswap-v3", type: "dex" } }, ...relationships,
      },
    };
  }
  const reply = (data: unknown) => new Response(JSON.stringify({ data }));
  const run = (metrics: ReturnType<typeof graph>, extra: Partial<Parameters<typeof refreshPoolPrices>[0]> = {}) =>
    refreshPoolPrices({ ...context(metrics), db: makeNoopD1(), sourceStartedAtSec: now - 60, apiKey: "test", ...extra });
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.spyOn(cg, "onchainRateLimit").mockResolvedValue();
    vi.spyOn(breaker, "shouldAttemptFetch").mockResolvedValue(true);
    const closed: breaker.CircuitRecord = { state: "closed", consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null, openedAt: null };
    vi.spyOn(breaker, "recordOutcome").mockResolvedValue({ before: closed, after: closed });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("deduplicates the complete hidden-contributor graph into 30+1 requests and preserves fixed-input Liquidity scores", async () => {
    const pools = Array.from({ length: 31 }, (_, i) => pool(i));
    const quote = pool(0, { priceEvidenceTvlUsd: 200_000, source: "direct_api" });
    const metrics = graph(pools, [quote]);
    const score = () => computeLiquidityScore(withCompleteVolume({ ...scorePoolGraph(metrics.get("usdc-circle")!), totalVolume24hUsd: 31e6 }), 60, 1e9);
    const before = score();
    const originals = structuredClone([...pools, quote]);
    const fetch = vi.fn(async (url: string) => reply(url.includes(address(30)) ? [row(30)] : pools.slice(0, 30).map((_, i) => row(i))));
    vi.stubGlobal("fetch", fetch);
    expect(measurePriceRefreshDemand(context(metrics))).toMatchObject({ pools: 31, requests: 2, networks: [{ network: "eth", pools: 31, requests: 2 }] });
    expect(measurePriceRefreshDemand(context(graph([pool(0, { chain: "sui", poolId: `sui:0x${"a".repeat(64)}`, project: "cetus" })]))).networks)
      .toEqual([{ network: "sui-network", pools: 1, requests: 1 }]);
    const result = await run(metrics);
    expect(result).toMatchObject({ requests: 2, breakerWrites: 2, refreshed: 32, unchangedByReason: {} });
    expect(fetch.mock.calls.map(([url]) => url.split("/multi/")[1]!.split("?")[0]!.split(",").length)).toEqual([30, 1]);
    expect(cg.onchainRateLimit).toHaveBeenNthCalledWith(2, 1, undefined);
    [...pools, quote].forEach((value, i) => expect(value).toEqual({
      ...originals[i], price: i === 31 ? 0.998 : 1.002, priceObservedAt: now, priceSource: "cg_onchain", priceEvidenceTvlUsd: i === 31 ? 80_000 : 30_000,
    }));
    expect(score()).toEqual(before);
    expect(before.score).not.toBeNull();
  });

  it("includes exact direct fallbacks and skips only quote identities captured in this invocation", async () => {
    const fresh = pool(0, { priceObservedAt: now - 30 });
    const fallback = pool(1, { price: undefined });
    const unobservedRecent = pool(2, { priceObservedAt: now - 10 });
    const metrics = graph([fresh, fallback]);
    const priceObservations = new Map<string, DexPriceObs[]>([["usdc-circle", [makeObs({
      poolKey: fallback.poolId, identityConfidence: "exact", sourceFamily: "direct_api", observedAt: now - 1000, tvl: 60_000,
    })]]]);
    const observedThisRun = captureObservedPoolPrices({ metrics, priceObservations }, now - 60);
    metrics.get("usdc-circle")!.pools.push(unobservedRecent);
    vi.stubGlobal("fetch", vi.fn(async () => reply([row(1), row(2)])));
    expect(measurePriceRefreshDemand({ ...context(metrics), priceObservations, observedThisRun })).toMatchObject({ pools: 2, observedThisRun: 1, requests: 1 });
    expect(await run(metrics, { priceObservations, observedThisRun })).toMatchObject({ refreshed: 2 });
    expect(fresh.priceObservedAt).toBe(now - 30);
    expect(fallback).toMatchObject({ price: 1.002, priceEvidenceTvlUsd: 60_000, priceObservedAt: now, source: "dl" });
    expect(buildDexPriceObservationsFromRetainedPools(new Map([["usdc-circle", [fallback]]]), priceObservations).get("usdc-circle"))
      .toEqual([expect.objectContaining({ price: 1.002, observedAt: now, sourceFamily: "cg_onchain", tvl: 60_000 })]);
  });

  it.each([
    ["not-returned", () => []],
    ["malformed-payload", () => [{ invalid: true }]],
    ["identity-mismatch", () => [{ ...row(1), id: `bsc_${address(1)}` }]],
    ["identity-mismatch", () => [row(1, {}, { base_token: { data: { id: `bsc_${token("usdc-circle")}`, type: "token" } } })]],
    ["identity-mismatch", () => [row(1, {}, { quote_token: { data: { id: `eth_invalid_${token("usdt-tether")}`, type: "token" } } })]],
    ["tracked-leg-mismatch", () => [row(1, {}, { base_token: { data: { id: `eth_${address(100)}`, type: "token" } } })]],
    ["invalid-price", () => [row(1, { base_token_price_usd: "NaN" })]],
    ["invalid-support-tvl", () => [row(1, { reserve_in_usd: "999" })]],
    ["incoherent-price", () => [row(1, { base_token_price_quote_token: "0" })]],
    ["implausible-price", () => [row(1, { base_token_price_usd: "1000" })]],
  ] as const)("keeps all original fields for %s while publishing a healthy sibling", async (reason, rows) => {
    const pools = [pool(0), pool(1)];
    const original = structuredClone(pools[1]);
    vi.stubGlobal("fetch", vi.fn(async () => reply([row(0), ...rows()])));
    const result = await run(graph(pools));
    expect(result).toMatchObject({ refreshed: 1, unchangedByReason: { [reason]: 1 }, failures: [expect.objectContaining({ poolId: pools[1]!.poolId, observedAt: original!.priceObservedAt, reason })] });
    expect(pools[0]!.priceObservedAt).toBe(now);
    expect(pools[1]).toEqual(original);
  });

  it.each([429, 500])("preserves clocks on HTTP %i, consumes bodies and stops after three failures", async (status) => {
    const pools = Array.from({ length: 91 }, (_, i) => pool(i));
    const originals = structuredClone(pools);
    const responses: Response[] = [];
    const fetch = vi.fn(async () => { const res = new Response("provider failure", { status }); responses.push(res); return res; });
    vi.stubGlobal("fetch", fetch);
    expect(await run(graph(pools))).toMatchObject({ requests: 3, refreshed: 0, unchangedByReason: { "coingecko-transport-failure": 90, "consecutive-failures": 1 }, failuresOmitted: 27 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(responses.every((res) => res.bodyUsed)).toBe(true);
    expect(pools).toEqual(originals);
  });

  it.each(["budget", "key", "circuit", "unmapped", "unaddressable"] as const)("retains contributors when %s prevents acquisition", async (mode) => {
    const original = pool(0, mode === "unmapped" ? { chain: "unknown", poolId: `unknown:${address(0)}` }
      : mode === "unaddressable" ? { poolId: "ethereum:unsafe/id" } : {});
    const before = structuredClone(original);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(breaker.shouldAttemptFetch).mockResolvedValue(mode !== "circuit");
    const reason = { budget: "budget-exhausted", key: "missing-api-key", circuit: "circuit-open", unmapped: "unmapped-network", unaddressable: "unaddressable-pool" }[mode]!;
    const result = await run(graph([original]), { apiKey: mode === "key" ? null : "test", deadline: mode === "budget" ? createSlotDeadline(now * 1000, now * 1000 + 25_000) : undefined });
    expect(result.unchangedByReason).toEqual({ [reason]: 1 });
    expect(original).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([125, 126])("bounds %i planned batches at 125 requests", async (batches) => {
    const pools = Array.from({ length: 30 * (batches - 1) + 1 }, (_, i) => pool(i));
    const fetch = vi.fn(async () => reply([]));
    vi.stubGlobal("fetch", fetch);
    const result = await run(graph(pools));
    expect(fetch).toHaveBeenCalledTimes(125);
    expect(result.stopReason).toBe(batches === 125 ? "completed" : "request-cap");
    expect(pools.every((p) => p.priceObservedAt === now - 6 * 3600)).toBe(true);
  });

  it.each(["budget", "deadline"] as const)("stops on the %s after a successful first batch", async (kind) => {
    const pools = Array.from({ length: 31 }, (_, i) => pool(i));
    const elapsed = kind === "budget" ? 90_000 : 3_000;
    const fetch = vi.fn(async () => { vi.mocked(Date.now).mockReturnValue(now * 1000 + elapsed); return reply([row(0)]); });
    vi.stubGlobal("fetch", fetch);
    const result = await run(graph(pools), { readinessDeadlineMs: kind === "deadline" ? now * 1000 + 30_000 : undefined });
    expect(result).toMatchObject({ requests: 1, refreshed: 1, elapsedMs: elapsed, stopReason: kind, unchangedByReason: { "budget-exhausted": 1 } });
    expect(pools[0]!.priceObservedAt).toBe(now);
    expect(pools[30]!.priceObservedAt).toBe(now - 6 * 3600);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("orders unknown and oldest clocks across networks, batches and coin attributions", async () => {
    const pools = Array.from({ length: 31 }, (_, i) => pool(i, { priceObservedAt: now - (i === 30 ? 500 : 100) }));
    pools.push(pool(90, { chain: "polygon", poolId: `polygon:${address(90)}`, priceObservedAt: null }));
    const fetch = vi.fn(async (_url: string) => reply([]));
    vi.stubGlobal("fetch", fetch);
    await run(graph(pools, [pool(0, { priceObservedAt: now - 1_000 })]));
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls.map((url) => url.split("/networks/")[1]!.split("/")[0])).toEqual(["polygon_pos", "eth", "eth"]);
    expect(urls[1]!.split("/multi/")[1]!.split(",").slice(0, 2)).toEqual([address(0), address(30)]);
    expect(urls[2]).toContain(address(29));
  });

  it.each([false, true])("splits a rejected400 once and preserves failed half clocks (%s)", async (rejectHalf) => {
    const pools = [0, 1, 2, 3].map((i) => pool(i));
    const responses: Response[] = [];
    const fetch = vi.fn(async () => {
      const call = responses.length;
      const response = call === 0 || (rejectHalf && call === 1) ? new Response("batch rejected", { status: 400 })
        : reply((call === 1 ? [0, 1] : [2, 3]).map((i) => row(i)));
      responses.push(response); return response;
    });
    vi.stubGlobal("fetch", fetch);
    const result = await run(graph(pools));
    expect(result).toMatchObject({ requests: 3, batchSplits: 1, refreshed: rejectHalf ? 2 : 4,
      batchFailures: { "coingecko-batch-rejected": 1, ...(rejectHalf ? { "split-batch-rejected": 1 } : {}) } });
    expect(result.unchangedByReason).toEqual(rejectHalf ? { "batch-rejected": 2 } : {});
    expect(pools.map((p) => p.priceObservedAt)).toEqual(pools.map((_, i) => rejectHalf && i < 2 ? now - 6 * 3600 : now));
    expect(responses.every((res) => res.bodyUsed)).toBe(true);
  });

  it.each([
    ["ethereum", "eth", `0x${"Ab".repeat(20)}`, true],
    ["ethereum", "eth", `0x${"Ab".repeat(32)}`, true],
    ["near", "near", "refv1-4512", false],
    ["near", "near", "refv2-AbC:Token.NEAR:2000", false],
    ["cardano", "cardano", "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c4c414a51eac26e5f913a91265c2882e013e1d74dab9a5fe2f875f7df7c9bb4c1", false],
    ["celo", "celo", `0x${"Ab".repeat(20)}-2045`, true],
    ["ethereum", "eth", "Opaque_Pool.1", false],
    ["ethereum", "eth", "X".repeat(200), false],
  ] as const)("refreshes indexed %s id %s/%s with safe encoding", async (chain, network, id, lowercase) => {
    const expected = lowercase ? id.toLowerCase() : id;
    const p = pool(0, { chain, poolId: `${chain}:${id}` }), response = row(0);
    response.id = `${network}_${expected}`;
    response.attributes.address = address(900); // Indexed IDs can differ from the contract address.
    response.relationships.base_token.data.id = `${network}_${token("usdc-circle", chain)}`;
    response.relationships.quote_token.data.id = `${network}_${address(100)}`;
    const fetch = vi.fn(async (_url: string) => reply([response]));
    vi.stubGlobal("fetch", fetch);
    expect(await run(graph([p]))).toMatchObject({ requests: 1, refreshed: 1, unchangedByReason: {} });
    expect(new URL(fetch.mock.calls[0]![0]).pathname.split("/multi/")[1]).toBe(encodeURIComponent(expected));
    expect(p).toMatchObject({ price: 1.002, priceObservedAt: now });
  });

  it.each(["bad,id", "bad/id", "", ".", "..", "a".repeat(201), "bad?id", "bad#id", " bad-id", "bad id", "orderbook:exchange:coin", "orderbook-exchange"])("never sends unsafe pool id %s", async (id) => {
    const p = pool(0, { poolId: `ethereum:${id}` });
    const before = structuredClone(p), fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await run(graph([p]))).toMatchObject({ requests: 0, unchangedByReason: { "unaddressable-pool": 1 } });
    expect(fetch).not.toHaveBeenCalled();
    expect(p).toEqual(before);
  });

  it.each(["ratio", "large", "dead", "paused", "quarantine", "inactive", "primary-missing"])("plans only publisher-retained contributors: %s", async (gate) => {
    const bad = pool(0, gate === "large" ? { tvlUsd: 1e9, volumeReading: undefined }
      : gate === "dead" ? { tvlUsd: DEX_DEAD_POOL_TVL_MIN_USD, volumeReading: { volume24hUsd: 0, volume7dUsd: null, observedAtSec: now, deadPoolSignature: true } }
        : gate === "ratio" ? { volumeReading: { volume24hUsd: 1e9, volume7dUsd: null, observedAtSec: now } }
          : gate === "paused" ? { extra: { executionCapabilityGate: { family: "balancer-amm", reason: "paused-or-swap-disabled" } } }
            : gate === "quarantine" ? { source: "cg_onchain" } : {});
    const metrics = graph([...(gate === "inactive" || gate === "primary-missing" ? [] : [bad]), pool(1)]);
    if (gate === "inactive") metrics.set("retired", { stablecoinId: "retired", symbol: "OLD", pools: [bad] });
    if (gate === "primary-missing") metrics.get("usdt-tether")!.pools.push(bad);
    if (gate === "quarantine") {
      metrics.get("usdt-tether")!.pools.push({ ...bad, tvlUsd: 200_000 });
      metrics.get("usdc-circle")!.pools[1]!.project = "uniswap-v3";
    }
    const before = structuredClone(bad), fetch = vi.fn(async (_url: string) => reply([row(1)]));
    vi.stubGlobal("fetch", fetch);
    expect(await run(metrics, { primaryPrices: new Map([["usdc-circle", 1], ["retired", 1]]), protocolTvlCaps: new Map(gate === "quarantine" ? [["balancer", 150_000]] : []) })).toMatchObject({ refreshed: 1, demand: { pools: 1 } });
    expect(fetch.mock.calls[0]![0]).not.toContain(address(0));
    expect(bad).toEqual(before);
  });
});

describe("protocol price evidence admission", () => {
  it("omits a zero-weight cross-source price while retaining healthy protocols", () => {
    const retained = buildDexPriceObservationsFromRetainedPools(new Map([["usdc-circle", [
      makePool({ project: "orca", price: 1, priceEvidenceTvlUsd: 0 }),
      makePool({ project: "balancer", price: 0.999, priceEvidenceTvlUsd: 200_000 }),
    ]]]));
    expect(retained.get("usdc-circle")).toEqual([
      expect.objectContaining({ protocol: "balancer", price: 0.999, tvl: 200_000 }),
    ]);
    const sources = aggregateProtocolSources([
      ...retained.get("usdc-circle")!,
      makeObs({ protocol: "orca", tvl: 0 }),
    ]);
    expect(sources).toEqual([
      expect.objectContaining({ protocol: "balancer", price: 0.999, tvl: 200_000 }),
    ]);
    expect(aggregateProtocolSources([makeObs({ tvl: 0 })])).toEqual([]);
  });
});

describe("isPlausibleDexObservationPrice guards peg", () => {
  it("rejects extreme off-peg prices for usdc-circle", () => {
    // Below the reference lower bound (1% of peg = $0.01)
    expect(isPlausibleDexObservationPrice("usdc-circle", 0.005)).toBe(false);
    expect(isPlausibleDexObservationPrice("usdc-circle", 0)).toBe(false);
    expect(isPlausibleDexObservationPrice("usdc-circle", -1)).toBe(false);
  });

  it("accepts near-peg prices for usdc-circle", () => {
    expect(isPlausibleDexObservationPrice("usdc-circle", 1.0001)).toBe(true);
    expect(isPlausibleDexObservationPrice("usdc-circle", 0.995)).toBe(true);
  });
});

// Minimal input builder for classifyCoverage – only sourceMix and totalTvlUsd vary per case.
function makeCoverageInput(
  sourceMix: LiquiditySourceMixByFamily,
  totalTvlUsd: number,
  overrides: Partial<Parameters<typeof classifyCoverage>[0]> = {},
) {
  return {
    sourceMix,
    totalTvlUsd,
    protocolCount: 1,
    sourceFamilyCount: 1,
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
    syntheticTvlUsd: 0,
    decayedTvlUsd: 0,
    measuredPriceTvlUsd: 0,
    ...overrides,
  };
}

describe("classifyCoverage", () => {
  it.each<[LiquiditySourceMixByFamily, number, string]>([
    [{ dl: { poolCount: 3, tvlUsd: 10_000_000 } }, 10_000_000, "primary"],
    [{ dl: { poolCount: 2, tvlUsd: 4_000_000 }, direct_api: { poolCount: 1, tvlUsd: 1_000_000 } }, 5_000_000, "primary"],
    [{ dl: { poolCount: 2, tvlUsd: 4_000_000 }, cg_onchain: { poolCount: 1, tvlUsd: 1_000_000 } }, 5_000_000, "mixed"],
    [{ cg_onchain: { poolCount: 2, tvlUsd: 3_000_000 } }, 3_000_000, "fallback"],
    [{ cg_tickers: { poolCount: 1, tvlUsd: 2_000_000 } }, 2_000_000, "fallback"],
    [{}, 5_000_000, "unobserved"],
  ])("classifies source mix %j with TVL %d as %s", (mix, tvl, expected) => {
    expect(classifyCoverage(makeCoverageInput(mix, tvl)).coverageClass).toBe(expected);
  });

  it.each<[string, LiquiditySourceMixByFamily, number, Partial<Parameters<typeof classifyCoverage>[0]>, string, number]>([
    ["returns primary when all TVL is from direct_api source", { direct_api: { poolCount: 2, tvlUsd: 5_000_000 } }, 5_000_000, {}, "primary", 0.6],
    ["returns unobserved when totalTvlUsd is zero", {}, 0, {}, "unobserved", 0],
    ["caps coverageConfidence at 1 for fully measured broad primary coverage", { dl: { poolCount: 10, tvlUsd: 100 } }, 100,
      { protocolCount: 10, sourceFamilyCount: 10, balanceMeasuredTvlUsd: 100, organicMeasuredTvlUsd: 100, measuredPriceTvlUsd: 100 }, "primary", 1],
    ["floors coverageConfidence at 0 when fallback coverage is fully synthetic and decayed", { cg_onchain: { poolCount: 1, tvlUsd: 100 } }, 100,
      { syntheticTvlUsd: 100, decayedTvlUsd: 100 }, "fallback", 0],
    ["blends coverageConfidence for mixed measured and fallback evidence", { dl: { poolCount: 2, tvlUsd: 60 }, cg_onchain: { poolCount: 1, tvlUsd: 40 } }, 100,
      { protocolCount: 2, sourceFamilyCount: 2, balanceMeasuredTvlUsd: 50, organicMeasuredTvlUsd: 25, measuredPriceTvlUsd: 20, syntheticTvlUsd: 10, decayedTvlUsd: 20 }, "mixed", 0.61],
  ])("%s", (name, mix, tvl, overrides, expectedClass, confidence) => {
    const { coverageClass, coverageConfidence } = classifyCoverage(makeCoverageInput(mix, tvl, overrides));
    expect(coverageClass).toBe(expectedClass);
    if (name.startsWith("blends")) expect(coverageConfidence).toBeCloseTo(confidence, 6);
    else expect(coverageConfidence).toBe(confidence);
  });
});

describe("aggregateProtocolSources", () => {
  it("preserves source family on protocol-source rows for depeg corroboration", () => {
    const aggregated = aggregateProtocolSources([
      makeObs({ protocol: "curve", price: 0.99, tvl: 1_000_000, sourceFamily: "dl" }),
      makeObs({ protocol: "curve", price: 0.98, tvl: 2_000_000, sourceFamily: "gecko_terminal" }),
      makeObs({ protocol: "uniswap", price: 0.97, tvl: 3_000_000, sourceFamily: "gecko_terminal" }),
    ]);

    expect(aggregated).toEqual([
      expect.objectContaining({ protocol: "uniswap", sourceFamily: "gecko_terminal", tvl: 3_000_000 }),
      expect.objectContaining({ protocol: "curve", sourceFamily: "gecko_terminal", tvl: 2_000_000 }),
      expect.objectContaining({ protocol: "curve", sourceFamily: "dl", tvl: 1_000_000 }),
    ]);
  });

  it("ages each family by its oldest admitted contributor, not excluded or sibling evidence", () => {
    const aggregated = aggregateProtocolSources([
      makeObs({ protocol: "curve", sourceFamily: "dl", observedAt: 1_000 }),
      makeObs({ protocol: "curve", sourceFamily: "dl", observedAt: 2_000 }),
      makeObs({ protocol: "curve", sourceFamily: "dl", observedAt: 1, tvl: 0 }),
      makeObs({ protocol: "curve", sourceFamily: "gecko_terminal", observedAt: 3_000 }),
    ]);
    expect(aggregated).toEqual([
      expect.objectContaining({ sourceFamily: "dl", observedAt: 1_000 }),
      expect.objectContaining({ sourceFamily: "gecko_terminal", observedAt: 3_000 }),
    ]);
    expect(aggregateProtocolSources([
      makeObs({ observedAt: 1_000 }), makeObs({ observedAt: undefined }),
    ])[0]?.observedAt).toBeUndefined();
  });
});

describe("collapseDuplicateObservations", () => {
  it("collapses two observations sharing the same pool key to one", () => {
    const obs = [
      makeObs({ poolKey: "ethereum:0xabc", price: 0.999, tvl: 2_000_000, observedAt: 2_000 }),
      makeObs({ poolKey: "ethereum:0xabc", price: 1.001, tvl: 1_000_000, observedAt: 1_000 }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(1);
    expect(duplicateGroups).toBe(1);
    expect(duplicateObservations).toBe(1);
    // Representative is the higher-TVL entry; price is median of [0.999, 1.001]
    expect(collapsed[0]!.price).toBeCloseTo(1.0, 5);
    expect(collapsed[0]!.tvl).toBe(2_000_000);
    expect(collapsed[0]!.observedAt).toBe(1_000);
  });

  it("collapses two observations sharing derivedMatchKey (derived_unique) to one", () => {
    const obs = [
      makeObs({ derivedMatchKey: "usdc:usdt:curve", identityConfidence: "derived_unique", price: 1.0, tvl: 3_000_000 }),
      makeObs({ derivedMatchKey: "usdc:usdt:curve", identityConfidence: "derived_unique", price: 1.002, tvl: 2_000_000 }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(1);
    expect(duplicateGroups).toBe(1);
    expect(duplicateObservations).toBe(1);
    expect(collapsed[0]!.tvl).toBe(3_000_000);
  });

  it("preserves distinct observations without a shared key", () => {
    const obs = [
      makeObs({ poolKey: "ethereum:0x111", identityConfidence: "exact" }),
      makeObs({ poolKey: "ethereum:0x222", identityConfidence: "exact", protocol: "curve" }),
      makeObs({ poolKey: "ethereum:0x333", identityConfidence: "exact", protocol: "balancer" }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(3);
    expect(duplicateGroups).toBe(0);
    expect(duplicateObservations).toBe(0);
  });

  it("passes through observations with no identifiable key (no poolKey, not derived_unique)", () => {
    const obs = [
      makeObs({ identityConfidence: "none" }),
      makeObs({ identityConfidence: "derived_ambiguous", derivedMatchKey: "usdc:usdt" }),
    ];
    const { collapsed, duplicateGroups } = collapseDuplicateObservations(obs);
    // Both lack a qualifying key, so both pass through unchanged
    expect(collapsed).toHaveLength(2);
    expect(duplicateGroups).toBe(0);
  });
});

describe("buildDexPriceObservationsFromRetainedPools", () => {
  const build = (pools: PoolEntry[], evidence?: DexPriceObs[], id = "test-dollar") => buildDexPriceObservationsFromRetainedPools(
    new Map([[id, pools]]), evidence && new Map([[id, evidence]]),
  );
  it("joins exact direct evidence to an unpriced retained primary pool", () => {
    const pool = makePool({ poolId: "ethereum:0xtest", project: "balancer", tvlUsd: 52_000, price: undefined, source: "dl" });
    const result = build([pool], [makeObs({
      price: 0.919816, tvl: 53_000, chain: "ethereum", protocol: "balancer", poolKey: "ethereum:0xtest",
      identityConfidence: "exact", sourceFamily: "direct_api",
    })]);
    expect(result.get("test-dollar")).toEqual([
      expect.objectContaining({ price: 0.919816, tvl: 52_000, poolKey: "ethereum:0xtest", sourceFamily: "direct_api" }),
    ]);
  });

  it("does not join derived, mismatched, or sub-threshold evidence", () => {
    const pool = makePool({ poolId: "ethereum:0xretained", tvlUsd: 52_000, price: undefined });
    const result = build([pool], [
      makeObs({ poolKey: "ethereum:0xretained", identityConfidence: "derived_unique" }),
      makeObs({ poolKey: "ethereum:0xother", identityConfidence: "exact" }),
      makeObs({ poolKey: "ethereum:0xretained", identityConfidence: "exact", tvl: 49_999 }),
    ]);
    expect(result.has("test-dollar")).toBe(false);
  });

  it("does not join exact evidence from non-direct sources", () => {
    const pool = makePool({ poolId: "ethereum:0xretained", tvlUsd: 52_000, price: undefined });
    const result = build([pool], [makeObs({
      poolKey: "ethereum:0xretained", identityConfidence: "exact", sourceFamily: "dexscreener",
    })], "usp-pareto-credit");
    expect(result.has("usp-pareto-credit")).toBe(false);
  });

  it("attributes a cross-source price to the family that observed it with capped TVL weight", () => {
    const hybrid = makePool({
      poolId: "ethereum:0xhybrid", project: "uniswap-v3", tvlUsd: 200_000, price: 0.998, source: "dl",
      priceSource: "cg_onchain", priceEvidenceTvlUsd: 100_000, priceObservedAt: 1_000,
    });
    const sameSource = makePool({ poolId: "ethereum:0xsame", project: "curve", tvlUsd: 80_000, price: 0.999, source: "cg_onchain" });
    const result = build([hybrid, sameSource]);
    expect(result.get("test-dollar")).toEqual([
      // Weight follows the price row's own $100K claim, not the DL row's $200K.
      expect.objectContaining({ price: 0.998, observedAt: 1_000, tvl: 100_000, sourceFamily: "cg_onchain" }),
      expect.objectContaining({ price: 0.999, tvl: 80_000, sourceFamily: "cg_onchain" }),
    ]);
  });
});

describe("quarantineProtocolTvlOutliers", () => {
  it.each([
    "cg_onchain", "gecko_terminal", "dexscreener", "cg_tickers", "horizon", "aquarius",
    "tezos", "icon-balanced", "kava-swap", "osmosis-sqs", "noble-swap",
  ] as const)("rejects the entire oversized %s group, preserving raw and modeled values", (source) => {
    const trusted = makePool({ source: "direct_api", tvlUsd: 150_000 });
    const fallback = makePool({
      poolId: "ethereum:0xfallback", source, tvlUsd: 80_000,
      extra: { qualityAdjustedTvl: 40_000, effectiveTvl: 20_000 },
    });
    const pools = new Map([["coin", [trusted, fallback]]]);
    expect(quarantineProtocolTvlOutliers(pools, new Map([["balancer", 180_000]]))).toEqual({
      reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 80_000,
    });
    expect(pools.get("coin")).toEqual([trusted]);
    expect(fallback).toMatchObject({
      tvlUsd: 80_000, extra: { qualityAdjustedTvl: 40_000, effectiveTvl: 20_000 },
    });
    expect(fallback.extra?.measurement).toBeUndefined();
  });

  it("rejects the whole fallback group when individually plausible pools exceed shared headroom", () => {
    const trusted = makePool({ source: "dl", tvlUsd: 70_000 });
    const a = makePool({ poolId: "ethereum:a", source: "gecko_terminal", tvlUsd: 20_000 });
    const b = makePool({ poolId: "ethereum:b", source: "dexscreener", tvlUsd: 25_000 });
    for (const fallback of [[a, b], [b, a]]) {
      const pools = new Map([["coin", [trusted, ...fallback]]]);
      expect(quarantineProtocolTvlOutliers(pools, new Map([["balancer", 100_000]]))).toMatchObject({
        poolCount: 2, protocolCount: 1, tvlUsd: 45_000,
      });
      expect(pools.get("coin")).toEqual([trusted]);
    }
    expect([a.tvlUsd, b.tvlUsd]).toEqual([20_000, 25_000]);
  });

  it("propagates a physical fallback rejection across coin views and counts it once", () => {
    const trusted = makePool({ source: "dl", tvlUsd: 90_000 });
    const suspect = makePool({ poolId: "ethereum:0xfallback", source: "gecko_terminal", tvlUsd: 20_000 });
    const healthy = makePool({ poolId: "base:0xhealthy", project: "orca", source: "gecko_terminal", tvlUsd: 20_000 });
    const pools = new Map([["usdc-circle", [trusted, suspect]], ["usdt-tether", [{ ...suspect }, healthy]]]);
    expect(quarantineProtocolTvlOutliers(pools, new Map([["balancer", 100_000]]))).toMatchObject({
      poolCount: 1, protocolCount: 1, tvlUsd: 20_000,
    });
    expect(pools.get("usdc-circle")).toEqual([trusted]);
    expect(pools.get("usdt-tether")).toEqual([healthy]);
  });

  it.each([100_000, 200_000, 0, Number.NaN, undefined])("admits raw fallback at/below a usable bound or without evidence (%s)", (cap) => {
    const pool = makePool({
      source: "gecko_terminal", tvlUsd: 100_000,
      extra: { qualityAdjustedTvl: 60_000, effectiveTvl: 30_000 },
    });
    const pools = new Map([["coin", [pool]]]);
    expect(quarantineProtocolTvlOutliers(pools, cap == null ? new Map() : new Map([["balancer", cap]]))).toMatchObject({
      poolCount: 0, protocolCount: 0, tvlUsd: 0,
    });
    expect(pools.get("coin")?.[0]).toBe(pool);
    expect(pool).toMatchObject({ tvlUsd: 100_000, extra: { qualityAdjustedTvl: 60_000, effectiveTvl: 30_000 } });
  });
});

describe("filterRetainedPools", () => {
  it("drops large direct pools when zero volume is explicitly unmeasured", () => {
    const retained = filterRetainedPools([
      makePool({
        poolId: "base:0xslipstream",
        project: "aerodrome-slipstream",
        chain: "Base",
        tvlUsd: 150_000_000,
        volumeUsd1d: 0,
        source: "direct_api",
        extra: {
          measurement: {
            tvlMeasured: true,
            volumeMeasured: false,
          },
        },
      }),
    ]);

    expect(retained).toHaveLength(0);
  });

  it("still drops large pools with measured low volume", () => {
    const retained = filterRetainedPools([
      makePool({
        poolId: "ethereum:0xmeasured",
        tvlUsd: 150_000_000,
        volumeUsd1d: 0,
        extra: {
          measurement: {
            tvlMeasured: true,
            volumeMeasured: true,
          },
        },
      }),
    ]);

    expect(retained).toHaveLength(0);
  });

  describe("dead-pool floor (v6.92)", () => {
    const NOW = 1_800_000_000;
    const clock = { asOfSec: NOW, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC };
    const pool = (
      poolId: string,
      tvlUsd: number,
      reading: { volume24hUsd: number | null; ageSec?: number; signed?: boolean },
    ) => {
      const entry = makePool({ poolId, tvlUsd, volumeUsd1d: reading.volume24hUsd });
      entry.volumeReading = {
        volume24hUsd: reading.volume24hUsd,
        volume7dUsd: null,
        observedAtSec: NOW - (reading.ageSec ?? 3_600),
        ...(reading.signed ? { deadPoolSignature: true as const } : {}),
      };
      return entry;
    };

    it("drops a signed in-window zero from exactly the $1M threshold and keeps everything else", () => {
      const pools = [
        pool("ethereum:0xat", DEX_DEAD_POOL_TVL_MIN_USD, { volume24hUsd: 0, signed: true }),
        pool("ethereum:0xabove", 23_667_525, { volume24hUsd: 0, signed: true }),
        pool("ethereum:0xbelow", DEX_DEAD_POOL_TVL_MIN_USD - 0.01, { volume24hUsd: 0, signed: true }),
        // Measured zero without the signature: unverified provider zero or tracked counter-token.
        pool("ethereum:0xunsigned", 5_000_000, { volume24hUsd: 0 }),
        // Unknown volume is never a zero, signature or not.
        pool("ethereum:0xmissing", 5_000_000, { volume24hUsd: null, signed: true }),
        // A signed zero older than the admission window is stale, not measured.
        pool("ethereum:0xstale", 5_000_000, { volume24hUsd: 0, ageSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC + 1, signed: true }),
        pool("ethereum:0xtraded", 5_000_000, { volume24hUsd: 12, signed: true }),
      ];
      applyPoolVolumeEligibility(pools, clock);
      const tally = { poolCount: 0, tvlUsd: 0 };
      const retained = filterRetainedPools(pools, undefined, tally);

      expect(retained.map((entry) => entry.poolId)).toEqual([
        "ethereum:0xbelow",
        "ethereum:0xunsigned",
        "ethereum:0xmissing",
        "ethereum:0xstale",
        "ethereum:0xtraded",
      ]);
      expect(tally).toEqual({ poolCount: 2, tvlUsd: DEX_DEAD_POOL_TVL_MIN_USD + 23_667_525 });
    });

    it("leaves a signed zero above $100M to the large-pool floor", () => {
      const counters = initLiquidityFallbackCounters();
      const tally = { poolCount: 0, tvlUsd: 0 };
      const pools = [pool("polygon:0xubs", 100_337_203, { volume24hUsd: 0, signed: true })];
      applyPoolVolumeEligibility(pools, clock);

      expect(filterRetainedPools(pools, counters, tally)).toHaveLength(0);
      expect(counters.retainedExclusionLargePoolLowVolume).toBe(1);
      expect(tally.poolCount).toBe(0);
    });
  });
});

describe("DEC-19 retained pool volume", () => {
  const NOW = 1_800_000_000;
  const clock = { asOfSec: NOW, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC };
  const pool = (volume24hUsd: number | null, ageSec: number | null, tvlUsd = 1_000) => ({
    reading: { volume24hUsd, volume7dUsd: null, observedAtSec: ageSec == null ? null : NOW - ageSec },
    tvlUsd,
  });

  it("admits a reading exactly 72h old and excludes one a second older", () => {
    const summary = summarizeRetainedPoolVolume(
      [pool(100, 0), pool(50, 72 * 3600, 3_000), pool(1_000, 72 * 3600 + 1, 4_000), pool(50_000, 180 * 3600, 2_000)],
      clock,
    );
    expect(summary.totalVolume24hUsd).toBeNull();
    expect(summary.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial",
      reason: "pool-observations-stale",
      partialGrossUsd: 150,
      measuredPoolCount: 2,
      stalePoolCount: 2,
      maxObservationAgeSec: 72 * 3600,
      admittedTvlUsd: 4_000,
      retainedTvlUsd: 10_000,
      volumeCoverage: 0.4,
    });
  });

  it("keeps a complete measured zero at full coverage and nulls all-missing and mixed windows", () => {
    const zero = summarizeRetainedPoolVolume([pool(0, 60), pool(0, 0)], clock);
    expect(zero.totalVolume24hUsd).toBe(0);
    expect(zero.volumeAvailability["24h"]).toMatchObject({ completeness: "complete", volumeCoverage: 1 });
    const missing = summarizeRetainedPoolVolume([pool(null, 0), { reading: undefined, tvlUsd: 500 }], clock);
    expect(missing.totalVolume24hUsd).toBeNull();
    expect(missing.volumeAvailability["24h"]).toMatchObject({ completeness: "missing", volumeCoverage: 0 });
    const mixed = summarizeRetainedPoolVolume([pool(10, 0), pool(null, 0), pool(5, 200 * 3600)], clock);
    expect(mixed.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial",
      reason: "pool-observations-missing-and-stale",
      partialGrossUsd: 10,
    });
  });

  it("publishes only admitted pool volume and never a decayed or aged value", () => {
    const aged = makePool({ poolId: "ethereum:0xaged", volumeUsd1d: 50_000 });
    aged.volumeReading = pool(50_000, 180 * 3600).reading;
    aged.extra = { measurement: { volumeMeasured: true, decayed: true } };
    const admitted = makePool({ poolId: "ethereum:0xadmitted", volumeUsd1d: 7 });
    admitted.volumeReading = pool(7, 72 * 3600).reading;
    applyPoolVolumeEligibility([aged, admitted], clock);
    expect(aged.volumeUsd1d).toBeNull();
    expect(aged.volumeObservation).toEqual({ status: "stale", observedAtSec: NOW - 180 * 3600 });
    expect(aged.extra?.measurement?.volumeMeasured).toBe(false);
    expect(admitted.volumeUsd1d).toBe(7);
    expect(admitted.volumeObservation).toEqual({ status: "measured", observedAtSec: NOW - 72 * 3600 });
  });
});

describe("accumulateGlobalAggregate", () => {
  it("scopes physical and provider IDs to their chain while deduping proven cross-source attributions", () => {
    const seen = new Map<string, GlobalPoolAggregateEntry>();
    const protocols: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const chains = new Set<string>();
    const address = "0xabc0000000000000000000000000000000000000";
    const pools = [
      makePool({ poolId: address, chain: "Ethereum", source: "dl", tvlUsd: 100_000 }),
      makePool({ poolId: `ethereum:${address}`, chain: "ethereum", source: "direct_api", tvlUsd: 100_000 }),
      makePool({ poolId: address, chain: "base", tvlUsd: 200_000 }),
      makePool({ poolId: "ethereum:defillama:uuid", chain: "ethereum", tvlUsd: 50_000 }),
      makePool({ poolId: "base:defillama:uuid", chain: "base", tvlUsd: 75_000 }),
    ];
    const result = accumulateGlobalAggregate(pools, protocols, chainTvl, chains, seen);
    expect(result).toEqual({ totalTvl: 425_000, poolCount: 4 });
    expect(chainTvl).toEqual({ ethereum: 150_000, base: 275_000 });
  });

  it("dedupes the same poolId across stablecoins", () => {
    const seenTvl = new Map<string, GlobalPoolAggregateEntry>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const pool = makePool({});

    const a = accumulateGlobalAggregate([pool], protoTvl, chainTvl, chains, seenTvl);
    const b = accumulateGlobalAggregate([pool], protoTvl, chainTvl, chains, seenTvl);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(a.poolCount + b.poolCount).toBe(1);
  });

  it("lets the higher-TVL occurrence own the deduped pool, including its volume reading", () => {
    const seenTvl = new Map<string, GlobalPoolAggregateEntry>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const chains = new Set<string>();
    const lower = makePool({ chain: "ethereum", tvlUsd: 4_500_000 });
    lower.volumeReading = { volume24hUsd: 900_000, volume7dUsd: null, observedAtSec: 1 };
    const higher = makePool({ chain: "ethereum", tvlUsd: 5_000_000 });
    higher.volumeReading = { volume24hUsd: 1_000_000, volume7dUsd: 7_000_000, observedAtSec: 2 };

    const a = accumulateGlobalAggregate([lower], protoTvl, chainTvl, chains, seenTvl);
    const b = accumulateGlobalAggregate([higher], protoTvl, chainTvl, chains, seenTvl);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(protoTvl["balancer"]).toBe(5_000_000);
    expect(chainTvl["ethereum"]).toBe(5_000_000);
    expect(seenTvl.get("ethereum:0xabc")).toMatchObject({ tvl: 5_000_000, reading: higher.volumeReading });
  });
});
