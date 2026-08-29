import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllFetchRoutesUsed, mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";
import { assertAllD1MatchesUsed, mockD1Strict, type MockD1Database } from "@shared/test-utils/mock-d1";
import type { StablecoinMeta } from "@shared/types/core";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { DEPEG_PENDING_MIN_AGE_SEC, DEX_FRESHNESS_SEC } from "../../lib/constants";
import { normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import type { CollectedConfirmationEvidence, ConfirmationEvidenceInput, DexPoolChallengersByCoin, DexPriceRowsByCoin, DexPriceSourcesByCoin } from "../pending-depeg-confirmation";
import { collectConfirmationEvidence } from "../pending-depeg-confirmation-evidence";

vi.mock("../../lib/circuit-breaker", () => ({ recordOutcomeSafe: vi.fn(async () => undefined) }));

const NOW_SEC = 1_700_000_000;
const COIN_ID = "usdt-tether";
const usdMeta: StablecoinMeta = { id: COIN_ID, name: "Tether", symbol: "USDT", geckoId: "tether", flags: { backing: "crypto-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: false, navToken: false } };
const brlMeta: StablecoinMeta = { id: "brz-transfero", name: "Brazilian Digital Token", symbol: "BRZ", geckoId: "brz", flags: { backing: "rwa-backed", pegCurrency: "BRL", governance: "centralized", yieldBearing: false, rwa: true, navToken: false } };

function row(overrides: Partial<PendingDepegRow> = {}): PendingDepegRow {
  const firstSeenAt = overrides.first_seen_at ?? NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60;
  const firstSeenBps = overrides.first_seen_bps ?? -220;
  const firstPrice = overrides.first_price ?? 0.978;
  return { id: 1, stablecoin_id: COIN_ID, symbol: "USDT", peg_type: "peggedUSD", direction: "below", first_seen_bps: firstSeenBps, first_seen_at: firstSeenAt, first_price: firstPrice, last_seen_bps: firstSeenBps, last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC, last_price: firstPrice, peak_seen_bps: null, peak_price: null, peg_reference: 1, reason: "large-cap", updated_at: firstSeenAt, ...overrides };
}
function emptyEvidence(): CollectedConfirmationEvidence {
  return { confirmingSources: [], opposingSources: [], unavailableSources: [], circuitOpenSources: [], hardOpposingSources: [], offchainStatus: "insufficient", offchainSourceKey: null, offchainPeakCandidate: null, dexStatus: "insufficient", dexPeakCandidates: [], dexConfirmationKeys: [], cexStatus: "insufficient", cexPeakCandidate: null, poolStatus: "insufficient", poolConfirmations: [] };
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
    secondaryBar: 100,
    nativeSignal: null,
    nativePegQuote: undefined,
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
  return new Map([[COIN_ID, { stablecoin_id: COIN_ID, dex_price_usd: price, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: updatedAt }]]);
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
    expect(evidence).toMatchObject({ offchainStatus: "confirm", offchainSourceKey: "coingecko-confirm", offchainPeakCandidate: { bps: -500, price: 0.95 } });
    expect(evidence.confirmingSources).toContain("coingecko-confirm");
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
    expect(evidence.dexPeakCandidates).toEqual([{ bps: -500, price: 0.95 }, { bps: -500, price: 0.95 }, { bps: -510, price: 0.949 }]);
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
});

describe("collectConfirmationEvidence pool challenger status classification", () => {
  const poolCases = [
    { label: "reports poolStatus='contradict' when at least one qualifying pool is opposite-direction above bar", values: [{ price: 0.997, tvlUsd: 5_000_000, protocol: "curve", sourceFamily: "curve" }, { price: 1.012, tvlUsd: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap" }], status: "contradict", opposing: "pool:uniswap:uniswap", confirmations: 0 },
    { label: "reports poolStatus='confirm' with highTvl=true when a single qualifying pool has TVL >= $5M", values: [{ price: 0.98, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve" }], status: "confirm", confirmations: 1 },
    { label: "reports poolStatus='recover' only when every qualifying pool is under the secondary bar", values: [{ price: 0.998, tvlUsd: 5_000_000, protocol: "curve", sourceFamily: "curve" }, { price: 0.999, tvlUsd: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap" }], status: "recover", opposing: "pool:curve:curve", confirmations: 0 },
  ];
  it.each(poolCases)("$label", async ({ values, status, opposing, confirmations }) => {
    const evidence = await collect(noOffchain({ poolChallengers: pools(values) }));
    expect(evidence.poolStatus).toBe(status);
    expect(evidence.poolConfirmations).toHaveLength(confirmations);
    if (opposing) expect(evidence.opposingSources).toContain(opposing);
  });

  it("does not count same-protocol pool challengers as independent confirmation", async () => {
    const evidence = await collect(noOffchain({ poolChallengers: pools([{ price: 0.98, tvlUsd: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" }, { price: 0.979, tvlUsd: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "arbitrum" }]) }));
    expect(evidence.poolStatus).toBe("insufficient");
    expect(evidence.poolConfirmations).toHaveLength(1);
    expect(evidence.confirmingSources).toEqual([]);
  });
});
