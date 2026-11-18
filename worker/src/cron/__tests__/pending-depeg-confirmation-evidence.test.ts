import { DEPEG_PENDING_MIN_AGE_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllFetchRoutesUsed, mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";
import { assertAllD1MatchesUsed, mockD1Strict, type MockD1Database } from "@shared/test-utils/mock-d1";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

import { normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import type { CollectedConfirmationEvidence, ConfirmationEvidenceInput, DexPoolChallengersByCoin, DexPriceRowsByCoin, DexPriceSourcesByCoin } from "../pending-depeg-confirmation";
import { collectConfirmationEvidence } from "../pending-depeg-confirmation-evidence";
import { emptyEvidence } from "./pending-depeg-confirmation.test-support";
import { makePendingDepegRow } from "../../test-helpers/pending-depeg-fixtures";
import { tradedPair } from "../depeg-detection/__tests__/reference-fixtures";
import { loadDexPrices } from "../../lib/depeg-helpers";
import { buildStoredChallengerPoolsJson } from "../dex-liquidity/challenger-publish";
import type { PoolEntry } from "../dex-liquidity/types";

vi.mock("../../lib/circuit-breaker", () => ({ recordOutcomeSafe: vi.fn(async () => undefined) }));

const NOW_SEC = 1_700_000_000;
const COIN_ID = "usdt-tether";
const poolAddress = (digit: string) => `ethereum:0x${digit.repeat(40)}`;
const usdMeta: StablecoinMeta = { id: COIN_ID, name: "Tether", symbol: "USDT", geckoId: "tether", flags: { backing: "crypto-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: false, navToken: false } };
const brlMeta: StablecoinMeta = { id: "brz-transfero", name: "Brazilian Digital Token", symbol: "BRZ", geckoId: "brz", flags: { backing: "rwa-backed", pegCurrency: "BRL", governance: "centralized", yieldBearing: false, rwa: true, navToken: false } };

function row(overrides: Partial<PendingDepegRow> = {}): PendingDepegRow {
  const firstSeenAt = overrides.first_seen_at ?? NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60;
  const firstSeenBps = overrides.first_seen_bps ?? -220;
  const firstPrice = overrides.first_price ?? 0.978;
  return makePendingDepegRow({ id: 1, stablecoin_id: COIN_ID, symbol: "USDT", first_seen_at: firstSeenAt, first_seen_bps: firstSeenBps, first_price: firstPrice, last_seen_bps: firstSeenBps, last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC, last_price: firstPrice, updated_at: firstSeenAt, ...overrides });
}
function input(overrides: Partial<ConfirmationEvidenceInput> = {}): ConfirmationEvidenceInput {
  const value = overrides.row ?? row();
  const pendingState = overrides.pendingState ?? normalizePendingDepegRow(value);
  const db = overrides.db ?? mockD1Strict([]);
  const defaults = {
    asset: makeAsset({ id: value.stablecoin_id, symbol: value.symbol, geckoId: "tether", price: 0.94, priceSource: "defillama", agreeSources: ["defillama"] }),
    meta: usdMeta,
    pegReference: 1,
    threshold: 100,
    nativeSignal: null,
    nativePegQuote: undefined,
    nativeQuoteImplausibility: null,
    nativeSourceKey: "native:usd",
    authoritativePrice: 0.94,
    primaryStatus: "insufficient" as const,
    primarySameDirectionDepegged: false,
    primaryConfirmationSources: [],
    temporalSameDirectionConfirmed: true,
    age: DEPEG_PENDING_MIN_AGE_SEC + 60,
    dexPriceRows: new Map(),
    dexPriceSources: new Map(),
    poolChallengers: new Map(),
    cexAllowed: false,
    cexPrices: null,
    coingeckoAllowed: true,
    coingeckoApiKey: undefined,
    signal: undefined,
    now: NOW_SEC,
  };
  return { ...defaults, ...overrides, kind: "ready", db, row: value, pendingState, outcomeState: overrides.outcomeState ?? { ...pendingState }, evidence: overrides.evidence ?? emptyEvidence() };
}
function noOffchain(overrides: Partial<ConfirmationEvidenceInput> = {}): ConfirmationEvidenceInput {
  return input({ asset: makeAsset({ id: COIN_ID, symbol: "USDT", geckoId: undefined, price: 0.98 }), meta: undefined, ...overrides });
}
function dexRows(updatedAt = NOW_SEC - 30, price = 0.95): DexPriceRowsByCoin {
  return new Map([[COIN_ID, { stablecoin_id: COIN_ID, dex_price_usd: price, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: updatedAt, aggregateObservedAt: updatedAt }]]);
}
function dexSources(updatedAt = NOW_SEC - 30, price = 0.95): DexPriceSourcesByCoin {
  return new Map([[COIN_ID, [{ protocol: "curve", sourceFamily: "curve", chain: "ethereum", price, tvl: 3_000_000, updatedAt }, { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: price - 0.001, tvl: 2_000_000, updatedAt }]]]);
}
function pools(values: Array<{ price: number; tvlUsd: number; protocol: string; sourceFamily?: string; chain?: string }>): DexPoolChallengersByCoin {
  return new Map([[COIN_ID, values.map((value) => ({ ...value, chain: value.chain ?? "ethereum" }))]]);
}
async function collect(value: ConfirmationEvidenceInput, fetchSpy?: MockFetchSpy): Promise<CollectedConfirmationEvidence> {
  const evidence = await collectConfirmationEvidence(value);
  assertAllD1MatchesUsed(value.db as MockD1Database);
  if (fetchSpy) assertAllFetchRoutesUsed(fetchSpy);
  return evidence;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("collectConfirmationEvidence source-family independence", () => {
  it("collects an independent CoinGecko confirmation with a fresh timestamp", async () => {
    const fetchSpy = mockFetch([{ match: "api.coingecko.com/api/v3/simple/price", body: { tether: { usd: 0.95, last_updated_at: NOW_SEC - 30 } } }], { requireMatch: true });
    const evidence = await collect(input(), fetchSpy);
    expect(evidence).toMatchObject({ offchainStatus: "confirm", offchainSourceKey: "coingecko-confirm", offchainPeakCandidate: { bps: expect.closeTo(-500, 9), price: 0.95 } });
    expect(evidence.confirmingSources).toContain("coingecko-confirm");
  });

  it.each([NOW_SEC - 1_800, NOW_SEC + 300])("admits the fresh confirmation boundary at %s", async (observedAt) => {
    const fetchSpy = mockFetch([{ match: "api.coingecko.com/api/v3/simple/price", body: { tether: { usd: 0.95, last_updated_at: observedAt } } }], { requireMatch: true });
    const evidence = await collect(input(), fetchSpy);
    expect(evidence.offchainStatus).toBe("confirm");
    expect(evidence.confirmingSources).toContain("coingecko-confirm");
    expect(evidence.unavailableSources).toEqual(["dex:aggregate", "pool:challenger"]);
  });

  it("does not query the DefiLlama CoinGecko mirror for confirmation", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const evidence = await collect(input({ asset: makeAsset({ id: COIN_ID, symbol: "USDT", geckoId: "tether", price: 0.95, priceSource: "defillama-list+coingecko", agreeSources: ["defillama-list", "coingecko"] }) }), fetchSpy);
    expect(evidence.offchainStatus).toBe("insufficient");
    expect(evidence.offchainSourceKey).toBeNull();
    expect(evidence.confirmingSources).not.toContain("coingecko-confirm");
  });

  it("skips off-chain confirmation when the CoinGecko circuit breaker is open", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const evidence = await collect(input({ coingeckoAllowed: false }), fetchSpy);
    expect(evidence.circuitOpenSources).toContain("coingecko-confirm");
    expect(evidence.unavailableSources).not.toContain("coingecko-confirm");
  });

  const timestampCases = [
    { label: "treats a non-OK response as unavailable evidence", status: 400, body: { error: "rate-limited" }, expected: "coingecko-confirm:non-ok" },
    { label: "treats an empty response as unavailable evidence", body: {}, expected: "coingecko-confirm:empty-response" },
    { label: "treats missing CoinGecko confirmation timestamps as insufficient evidence", body: { tether: { usd: 0.95 } }, expected: "coingecko-confirm:missing-timestamp" },
    { label: "treats invalid CoinGecko confirmation timestamps as insufficient evidence", body: { tether: { usd: 0.95, last_updated_at: -1 } }, expected: "coingecko-confirm:invalid-timestamp" },
    { label: "treats future CoinGecko confirmation timestamps as insufficient evidence", body: { tether: { usd: 0.95, last_updated_at: NOW_SEC + 600 } }, expected: "coingecko-confirm:future-timestamp" },
    { label: "treats stale CoinGecko confirmation timestamps as insufficient evidence", body: { tether: { usd: 0.95, last_updated_at: NOW_SEC - 1_901 } }, expected: "coingecko-confirm:stale-timestamp" },
  ];
  it.each(timestampCases)("$label", async ({ status, body, expected }) => {
    const fetchSpy = mockFetch([{ match: "api.coingecko.com/api/v3/simple/price", body, ...(status == null ? {} : { status }) }], { requireMatch: true });
    const evidence = await collect(input(), fetchSpy);
    expect(evidence.unavailableSources).toContain(expected);
    expect(evidence.offchainStatus).toBe("insufficient");
    expect(evidence.confirmingSources).not.toContain("coingecko-confirm");
    expect(evidence.offchainPeakCandidate).toBeNull();
  });

  it("preserves native-origin independence by marking USD-derived sources unavailable", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const value = row({ stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", reason: "large-cap+native-origin", peg_reference: 0.18765951 });
    const evidence = await collect(input({ row: value, pendingState: normalizePendingDepegRow(value), asset: makeAsset({ id: value.stablecoin_id, symbol: value.symbol, geckoId: "brz", price: 0.18 }), meta: brlMeta, pegReference: value.peg_reference, nativeSourceKey: "native:brl", cexAllowed: true, cexPrices: new Map([["BRZ", 0.18]]) }), fetchSpy);
    expect(evidence.confirmingSources).toEqual([]);
    expect(evidence.unavailableSources).toEqual(expect.arrayContaining(["dex:usd-native-origin", "cex:usd-native-origin", "pool:usd-native-origin"]));
    expect(evidence.offchainStatus).toBe("insufficient");
  });
});

describe("collectConfirmationEvidence DEX source grouping and freshness", () => {
  it("groups independent DEX protocol families and retains peak candidates", async () => {
    const evidence = await collect(noOffchain({ dexPriceRows: dexRows(), dexPriceSources: dexSources() }));
    expect(evidence).toMatchObject({ dexStatus: "confirm", dexConfirmationKeys: ["dex:curve", "dex:uniswap"] });
    expect(evidence.dexPeakCandidates).toEqual([{ bps: expect.closeTo(-500, 9), price: 0.95, quoteDomain: "usd", pegReference: 1 }, { bps: expect.closeTo(-500, 9), price: 0.95, quoteDomain: "usd", pegReference: 1 }, { bps: expect.closeTo(-510, 9), price: 0.949, quoteDomain: "usd", pegReference: 1 }]);
    expect(evidence.confirmingSources).toEqual(["dex:curve", "dex:uniswap"]);
  });

  it("does not let one aggregate DEX protocol group promote a pending event", async () => {
    const evidence = await collect(noOffchain({ dexPriceRows: dexRows(), dexPriceSources: new Map([[COIN_ID, [
      { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.95, tvl: 3_000_000, updatedAt: NOW_SEC - 30 },
      { protocol: "curve", sourceFamily: "curve", chain: "arbitrum", price: 0.949, tvl: 2_000_000, updatedAt: NOW_SEC - 30 },
    ]]]) }));
    expect(evidence.dexStatus).toBe("insufficient");
    expect(evidence.dexConfirmationKeys).toEqual([]);
    expect(evidence.confirmingSources).toEqual([]);
  });

  it("does not let a thin DEX row promote a pending event without CoinGecko support", async () => {
    const evidence = await collect(noOffchain({ dexPriceRows: new Map([[COIN_ID, { stablecoin_id: COIN_ID, dex_price_usd: 0.96, deviation_from_primary_bps: null, source_pool_count: 1, source_total_tvl: 250_000, updated_at: NOW_SEC - 30 }]]) }));
    expect(evidence.dexStatus).toBe("insufficient");
    expect(evidence.unavailableSources).toContain("dex:aggregate-untrusted");
  });

  it("marks stale aggregate DEX data unavailable instead of classifying it", async () => {
    const stale = NOW_SEC - DEX_FRESHNESS_SEC - 1;
    const evidence = await collect(noOffchain({ dexPriceRows: dexRows(stale), dexPriceSources: dexSources(stale) }));
    expect(evidence.dexStatus).toBe("insufficient");
    expect(evidence.unavailableSources).toContain("dex:aggregate-untrusted");
  });

  it.each([
    { label: "legacy unclocked", clock: undefined },
    { label: "six-hour original", clock: NOW_SEC - 6 * 3600 },
    { label: "inclusive lane boundary with mixed clocks", clock: NOW_SEC - DEX_FRESHNESS_SEC },
  ])("cannot confirm or prove recovery from $label sources in a fresh aggregate", async ({ clock }) => {
    const boundary = clock === NOW_SEC - DEX_FRESHNESS_SEC;
    for (const price of [0.95, 0.997]) {
      const db = mockD1Strict([{
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json FROM dex_prices",
        rows: [{
          ...dexRows(NOW_SEC, price).get(COIN_ID)!,
          price_sources_json: JSON.stringify(["curve", "uniswap"].map((protocol, i) => ({
            protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 3_000_000,
            updatedAt: NOW_SEC,
            ...(clock === undefined ? {} : {
              observedAt: boundary ? NOW_SEC - 30 : clock,
              aggregateObservedAt: boundary && i ? NOW_SEC - 30 : clock,
            }),
          }))),
        }],
      }]);
      const loaded = await loadDexPrices(db, NOW_SEC);
      expect(loaded.dexPriceSources.size).toBe(boundary ? 1 : 0);
      const evidence = await collect(noOffchain({ db, ...loaded }));
      expect(evidence.dexStatus).toBe("insufficient");
      expect(evidence.dexConfirmationKeys).toEqual([]);
      expect(evidence.dexPeakCandidates).toEqual([]);
      expect(evidence.confirmingSources).toEqual([]);
      expect(evidence.hardOpposingSources).toEqual([]);
      expect(evidence.dexConfirmationVeto === true).toBe(boundary && price === 0.95);
    }
  });

  it.each([0.95, 0.997, 1.02])("keeps only a same-direction rejection veto from an old aggregate at %s", async (price) => {
    const rows = dexRows(NOW_SEC - 30, price);
    rows.get(COIN_ID)!.aggregateObservedAt = NOW_SEC - 6 * 3600;
    const evidence = await collect(noOffchain({ dexPriceRows: rows, dexPriceSources: dexSources(NOW_SEC - 30, price) }));
    expect(evidence.dexStatus).toBe("insufficient");
    expect(evidence.dexPeakCandidates).toEqual([]);
    expect(evidence.confirmingSources).toEqual([]);
    expect(evidence.opposingSources).toEqual([]);
    expect(evidence.hardOpposingSources).toEqual([]);
    expect(evidence.dexConfirmationVeto === true).toBe(price === 0.95);
    expect(evidence.unavailableSources).toContain("dex:aggregate-clock-stale");
  });
});

describe("collectConfirmationEvidence pool challenger status classification", () => {
  it("withholds pools, protocol votes and aggregates that overlap retained pending sources", async () => {
    const poolKey = poolAddress("1");
    const time = NOW_SEC - 30;
    const samples = [
      { protocol: "curve", sourceFamily: "curve", upstreamKeys: [poolKey, "venue:bitstamp"] },
      { protocol: "uniswap", sourceFamily: "uniswap", upstreamKeys: ["venue:binance"] },
    ].map((source) => ({ ...source, chain: "ethereum", price: 0.92, tvl: 2e6, tvlUsd: 2e6, updatedAt: time, observedAt: time }));
    const dexPriceRows = dexRows(time, 0.92);
    Object.assign(dexPriceRows.get(COIN_ID)!, { upstreamKeys: samples.flatMap((sample) => sample.upstreamKeys) });
    const pendingSourceKeys = new Set([poolKey, "binance"]);
    for (const asset of [undefined, makeAsset({ id: COIN_ID, price: 1, priceSource: "coingecko" })]) {
      const args = { asset, dexPriceRows, pendingSourceKeys,
        dexPriceSources: new Map([[COIN_ID, samples]]), poolChallengers: pools(samples) };
      const blocked = await collect(noOffchain(args));
      expect(blocked.confirmingSources).toEqual([]);
      expect(blocked.unavailableSources).toContain("dex:independence-unverified");
      const protocolOverlap = await collect(noOffchain({ ...args, dexPriceRows: dexRows(time, 0.92) }));
      expect(protocolOverlap.dexStatus).toBe("insufficient");
      const disjoint = await collect(noOffchain({ ...args, pendingSourceKeys: new Set(["pyth"]) }));
      expect(disjoint).toMatchObject({ dexStatus: "confirm", poolStatus: "confirm" });
    }
  });

  it("withholds a pool funded by the same named venue as a USD primary without ancestry", async () => {
    const asset = makeAsset({ id: COIN_ID, symbol: "USDT", price: 0.98, priceSource: "kraken",
      agreeSources: ["kraken"], priceConfidence: "single-source", priceObservedAtMode: "local_fetch" });
    const pool = { price: 0.98, tvlUsd: 6_000_000, protocol: "uniswap-v3", chain: "ethereum",
      sourceFamily: "direct_api", observedAt: NOW_SEC - 30 };
    for (const [upstreamKeys, expected] of [
      [["venue:bitstamp", "venue:kraken"], "insufficient"], [["venue:bitstamp"], "confirm"], [undefined, "confirm"],
    ] as const) {
      const candidate = upstreamKeys ? { ...pool, upstreamKeys } : pool;
      const evidence = await collect(noOffchain({ asset, coingeckoAllowed: false, poolChallengers: pools([candidate]) }));
      expect(evidence.poolStatus).toBe(expected);
      expect(evidence.poolConfirmations).toHaveLength(expected === "confirm" ? 1 : 0);
    }
  });

  it.each(["venue", "pool"] as const)("counts a shared conversion %s only once on both sides of publication", async (identity) => {
    const coin = "usg-tangent";
    const protocols = ["uniswap-v3", "balancer", "curve", "sushiswap"];
    const venues = ["kraken", "kraken+binance", "binance", "coinbase"];
    const poolKeys = ["1", "2", "3", "4"].map(poolAddress);
    const [left, right, independent] = [poolAddress("a"), poolAddress("b"), poolAddress("c")];
    const conversionPools = [[left], [left, right], [right], [independent]];
    const retained: PoolEntry[] = protocols.map((project, index) => ({
      poolId: poolKeys[index]!, project, stablecoinId: coin, chain: "ethereum", price: 0.98, source: "direct_api",
      tvlUsd: index === 1 ? 2e6 : 1e6, priceObservedAt: NOW_SEC - 30 - index, symbol: "USG-USDC", volumeUsd1d: 100, poolType: "stable",
      priceCounterparty: {
        stablecoinId: index === 3 ? COIN_ID : "usdc-circle", source: identity === "venue" ? venues[index]! : "pyth",
        priceUsd: 0.98, observedAtSec: NOW_SEC - 30,
        ...(identity === "pool" && { upstreamKeys: conversionPools[index], pricePoolKeys: conversionPools[index] }),
      },
    }));
    const samples = retained.map((pool, index) => ({
      price: pool.price!, observedAt: pool.priceObservedAt!, tvlUsd: pool.tvlUsd, protocol: pool.project,
      chain: pool.chain, sourceFamily: "direct_api", pricePoolKeys: [pool.poolId, ...(pool.priceCounterparty?.pricePoolKeys ?? [])],
      upstreamKeys: [pool.poolId, ...(pool.priceCounterparty?.upstreamKeys ?? venues[index]!.split("+").map((venue) => `venue:${venue}`))],
    }));
    const pending = row({ stablecoin_id: coin, symbol: "USG" });
    const asset = makeAsset({ id: coin, symbol: "USG", pegType: "peggedUSD", price: 0.98, priceSource: "pyth" });
    for (const [indices, expected] of [
      [[0, 1, 2], "insufficient"], [[2, 0, 1], "insufficient"], [[0, 2], "confirm"], [[0, 1, 2, 3], "confirm"],
    ] as const) {
      const evidence = await collect(noOffchain({
        row: pending, asset,
        poolChallengers: new Map([[coin, indices.map((index) => samples[index]!)]]),
      }));
      const stored = JSON.parse(buildStoredChallengerPoolsJson(coin, indices.map((index) => retained[index]!), 100_000, NOW_SEC)!);
      expect(evidence.poolStatus).toBe(expected);
      expect(stored.map((pool: { poolId: string }) => pool.poolId).sort()).toEqual([...indices].sort().map((index) => poolKeys[index]));
      expect(stored.every((pool: { priceUsd?: number }) => pool.priceUsd === undefined)).toBe(true);
    }
  });

  it.each([undefined, NOW_SEC - 6 * 3_600, NOW_SEC - 30])("requires an original clock for a high-TVL confirmer (%s)", async (observedAt) => {
    const candidate = { price: 0.96, tvlUsd: 5_100_000, protocol: "curve", chain: "ethereum", sourceFamily: "curve", observedAt };
    const evidence = await collect(noOffchain({ poolChallengers: pools([candidate]) }));
    expect(evidence.poolStatus).toBe(observedAt === NOW_SEC - 30 ? "confirm" : "insufficient");
    expect(evidence.poolConfirmations).toHaveLength(observedAt === NOW_SEC - 30 ? 1 : 0);
  });

  const poolCases = [
    { label: "reports poolStatus='contradict' when at least one qualifying pool is opposite-direction above bar", values: [{ price: 0.997, tvlUsd: 5_000_000, protocol: "curve", sourceFamily: "curve" }, { price: 1.012, tvlUsd: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap" }], status: "contradict", opposing: "pool:uniswap:uniswap", confirmations: 0 },
    { label: "withholds a clocked high-TVL pool with legacy placeholder identity", values: [{ price: 0.98, tvlUsd: 6_000_000, protocol: "unknown", sourceFamily: "legacy-challenger-pools" }], status: "insufficient", confirmations: 0 },
    { label: "reports poolStatus='confirm' with highTvl=true when a single qualifying pool has TVL >= $5M", values: [{ price: 0.98, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve" }], status: "confirm", confirmations: 1 },
    { label: "reports poolStatus='recover' only when every qualifying pool is under the secondary bar", values: [{ price: 0.998, tvlUsd: 5_000_000, protocol: "curve", sourceFamily: "curve" }, { price: 0.999, tvlUsd: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap" }], status: "recover", opposing: "pool:curve:curve", confirmations: 0 },
    // 2026-09-24 (vchf-vnx): two dormant diverging protocol groups (24h volume 0,
    // provider-reported reserves carrying a months-old price) must not confirm a
    // depeg while four independent protocols sit inside the bar.
    { label: "withholds poolStatus='confirm' when two diverging groups are outvoted by four inside-bar groups", values: [{ price: 0.98, tvlUsd: 1_000_000, protocol: "uniswap-v3", sourceFamily: "cg_onchain" }, { price: 0.979, tvlUsd: 1_000_000, protocol: "kongswap", sourceFamily: "cg_onchain" }, { price: 0.997, tvlUsd: 1_000_000, protocol: "icpswap", sourceFamily: "cg_onchain" }, { price: 0.9975, tvlUsd: 1_000_000, protocol: "raydium", sourceFamily: "direct_api" }, { price: 0.998, tvlUsd: 1_000_000, protocol: "aerodrome", sourceFamily: "direct_api" }, { price: 0.9985, tvlUsd: 1_000_000, protocol: "meteora", sourceFamily: "cg_onchain" }], status: "insufficient", confirmations: 0 },
  ];
  it.each(poolCases)("$label", async ({ values, status, opposing, confirmations }) => {
    const evidence = await collect(noOffchain({ poolChallengers: pools(values.map((pool) => ({ ...pool, observedAt: NOW_SEC - 30 }))) }));
    expect(evidence.poolStatus).toBe(status);
    expect(evidence.poolConfirmations).toHaveLength(confirmations);
    if (opposing) expect(evidence.opposingSources).toContain(opposing);
  });

  it("does not count same-protocol pool challengers as independent confirmation", async () => {
    const evidence = await collect(noOffchain({ poolChallengers: pools([{ price: 0.98, tvlUsd: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" }, { price: 0.979, tvlUsd: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "arbitrum" }]) }));
    expect(evidence.poolStatus).toBe("insufficient");
    expect(evidence.poolConfirmations).toHaveLength(0);
    expect(evidence.confirmingSources).toEqual([]);
  });

  it.each([0, 1, 2])("applies the opposing-group vote to a high-TVL confirmer against %s recovering groups", async (opposingCount) => {
    const values = [
      { price: 0.8, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve" },
      ...["uniswap", "aerodrome"].slice(0, opposingCount).map((protocol) => ({
        price: 1, tvlUsd: 6_000_000, protocol, sourceFamily: protocol,
      })),
    ];
    const evidence = await collect(noOffchain({ poolChallengers: pools(values.map((pool) => ({ ...pool, observedAt: NOW_SEC - 30 }))) }));
    expect(evidence.poolStatus).toBe(opposingCount <= 1 ? "confirm" : "insufficient");
    expect(evidence.poolConfirmations).toHaveLength(opposingCount <= 1 ? 1 : 0);
    expect(evidence.confirmingSources).toEqual(opposingCount <= 1 ? ["pool:curve:curve"] : []);
  });
});

describe("collectConfirmationEvidence native quote classification", () => {
  const nativeInput = (price: number) => input({
    nativePegQuote: { stablecoinId: COIN_ID, geckoId: "tether", pegCurrency: "USD", price, updatedAt: NOW_SEC - 30, derivation: tradedPair },
    nativeSignal: deriveDepegSignal(price, 1),
  });

  it("does not convert a native quote from another fiat domain into a USD event peak", async () => {
    const evidence = await collect(noOffchain({
      nativePegQuote: { stablecoinId: COIN_ID, geckoId: "tether", pegCurrency: "EUR", price: 0.9, updatedAt: NOW_SEC - 30 },
      nativeSignal: deriveDepegSignal(0.9, 1),
    }));
    expect(evidence.offchainStatus).toBe("insufficient");
    expect(evidence.offchainPeakCandidate).toBeNull();
    expect(evidence.confirmingSources).toEqual([]);
  });

  it.each(["binance", undefined])("withholds a same-venue or unidentified native pair (%s)", async (venue) => {
    const plan = nativeInput(0.95);
    const evidence = await collect({ ...plan,
      asset: makeAsset({ id: COIN_ID, priceSource: "binance", agreeSources: ["binance"] }),
      nativePegQuote: { ...plan.nativePegQuote!, derivation: { kind: "traded-pair", lineage: { venue } } },
      meta: undefined,
    });
    expect(evidence.offchainStatus).toBe("insufficient");
  });

  it.each(["legacy-primary", "legacy-challenger", "shared", "distinct", "invalid"] as const)("checks %s pool ancestry for a Curve primary", async (route) => {
    const curve = "ethereum:0x0000000000000000000000000000000000000001";
    const other = "ethereum:0x0000000000000000000000000000000000000002";
    const asset = { ...makeAsset({ id: COIN_ID, priceSource: "curve-onchain", agreeSources: ["curve-onchain"] }),
      ...(route === "legacy-primary" ? {} : { pricePoolKeys: [curve] }) };
    const candidate = { price: 0.95, observedAt: NOW_SEC - 30, tvlUsd: 6e6, protocol: "uniswap", sourceFamily: "uniswap",
      ...(route === "legacy-challenger" ? {} : { pricePoolKeys: route === "shared" ? [curve, other] : route === "invalid" ? [] : [other] }) };
    const evidence = await collect(noOffchain({ asset, poolChallengers: pools([candidate]) }));
    expect(evidence.poolStatus).toBe(route === "shared" || route === "invalid" ? "insufficient" : "confirm");
  });

  it.each(["audx-aussie-dollar-token", "qcad-stablecorp"])("deduplicates the reviewed Kraken/CoinGecko mirror for %s", async (id) => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const plan = nativeInput(0.95);
    const evidence = await collect({ ...plan,
      asset: makeAsset({ id, priceSource: "kraken", agreeSources: ["kraken"] }),
      nativePegQuote: undefined, nativeSignal: null,
    }, fetchSpy);
    expect(evidence.offchainStatus).toBe("insufficient");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("confirms off-chain status from a fresh native peg quote without querying CoinGecko", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const evidence = await collect(nativeInput(0.95), fetchSpy);
    expect(evidence.offchainStatus).toBe("confirm");
    expect(evidence.offchainSourceKey).toBe("native:usd");
    expect(evidence.offchainPeakCandidate).toMatchObject({ price: 0.95, quoteDomain: "usd", pegReference: 1 });
    expect(evidence.confirmingSources).toContain("native:usd");
  });

  it("adds a native peg quote back inside the bar as hard opposing evidence", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const evidence = await collect(nativeInput(1.05), fetchSpy);
    expect(evidence.offchainStatus).toBe("contradict");
    expect(evidence.offchainSourceKey).toBe("native:usd");
    expect(evidence.offchainPeakCandidate).toBeNull();
    expect(evidence.opposingSources).toContain("native:usd");
    expect(evidence.hardOpposingSources).toContain("native:usd");
  });
});

describe("collectConfirmationEvidence recover and opposing classification", () => {
  it("records an independent CoinGecko quote that settled back inside the bar as opposing evidence", async () => {
    const fetchSpy = mockFetch([{ match: "api.coingecko.com/api/v3/simple/price", body: { tether: { usd: 0.997, last_updated_at: NOW_SEC - 30 } } }], { requireMatch: true });
    const evidence = await collect(input(), fetchSpy);
    expect(evidence.offchainStatus).toBe("recover");
    expect(evidence.offchainSourceKey).toBe("coingecko-confirm");
    expect(evidence.offchainPeakCandidate).toBeNull();
    expect(evidence.opposingSources).toContain("coingecko-confirm");
    expect(evidence.unavailableSources.some((source) => source.startsWith("coingecko-confirm"))).toBe(false);
  });

  it("marks the DEX aggregate as recover when two independent protocol families settle inside the bar", async () => {
    const evidence = await collect(noOffchain({ dexPriceRows: dexRows(NOW_SEC - 30, 0.997), dexPriceSources: dexSources(NOW_SEC - 30, 0.997) }));
    expect(evidence.dexStatus).toBe("recover");
    expect(evidence.opposingSources).toEqual(expect.arrayContaining(["dex:curve", "dex:uniswap"]));
    expect(evidence.hardOpposingSources).toEqual(expect.arrayContaining(["dex-family:curve", "dex-family:uniswap"]));
    expect(evidence.confirmingSources).toEqual([]);
    expect(evidence.dexConfirmationKeys).toEqual([]);
  });

  it("confirms from a fresh Binance quote beyond the secondary bar", async () => {
    const evidence = await collect(noOffchain({ cexAllowed: true, cexPrices: new Map([["USDT", 0.95]]) }));
    expect(evidence.cexStatus).toBe("confirm");
    expect(evidence.cexPeakCandidate).toEqual({ bps: expect.closeTo(-500, 9), price: 0.95, quoteDomain: "usd", pegReference: 1 });
    expect(evidence.confirmingSources).toContain("cex:binance");
  });

  it("records an opposite-direction Binance quote as hard opposing evidence", async () => {
    const evidence = await collect(noOffchain({ cexAllowed: true, cexPrices: new Map([["USDT", 1.05]]) }));
    expect(evidence.cexStatus).toBe("contradict");
    expect(evidence.cexPeakCandidate).toBeNull();
    expect(evidence.opposingSources).toContain("cex:binance");
    expect(evidence.hardOpposingSources).toContain("cex:binance");
  });

  it("ignores pool challengers with unusable prices instead of classifying them", async () => {
    const evidence = await collect(noOffchain({ poolChallengers: pools([{ price: 0, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve" }]) }));
    expect(evidence.poolStatus).toBe("insufficient");
    expect(evidence.poolConfirmations).toEqual([]);
    expect(evidence.confirmingSources).toEqual([]);
  });
});
