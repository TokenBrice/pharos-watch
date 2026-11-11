import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonWithRetry } from "../fetch-retry";
import { isValidFxRate } from "../pricing/fx-config";
import { loadCommodityPeerMedianReference, resolveMetalReferenceRates, type MetalPegKey } from "../pricing/fx-metals";

const validateMetalRate = (pegKey: MetalPegKey, rate: number): boolean =>
  pegKey === "peggedGOLD"
    ? rate >= 500 && rate <= 10_000
    : rate >= 5 && rate <= 500;

const validateWithPriorDelta = (pegKey: MetalPegKey, rate: number, prevRate: number | undefined): boolean =>
  isValidFxRate(pegKey, rate, prevRate, "[fx-metals-test]");

function okResult(body: Record<string, unknown>) {
  return { response: new Response(JSON.stringify(body), { status: 200 }), body };
}

describe("resolveMetalReferenceRates", () => {
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
  });

  it("does not carry forward cached metal rates outside current bounds", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 100, peggedSILVER: 1_000 },
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });

    expect(result.resolvedByPeg.peggedGOLD).toBeUndefined();
    expect(result.resolvedByPeg.peggedSILVER).toBeUndefined();
  });

  it("does not synthesize provenance for live or peer-median metal values", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ price: 2_900 }), { status: 200 }),
        body: { price: 2_900 },
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ price: 32 }), { status: 200 }),
        body: { price: 32 },
      });

    const live = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });
    expect(live.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "gold-api.com",
      updatedAt: null,
    });

    vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(null);
    const peer = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: { peggedGOLD: 2_900 }, counts: { peggedGOLD: 3 }, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });
    expect(peer.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "commodity-peer-median",
      updatedAt: null,
    });
  });

  it.each([
    ["2026-09-22T16:41:36Z", 1_790_095_296],
    ["2026-09-21T16:41:36Z", 1_790_008_896],
    ["invalid", null],
    ["2027-01-01T00:00:00Z", null],
  ])("preserves actual provider time without refreshing it: %s", async (updatedAt, expected) => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      body: { price: 2_900, updatedAt },
    });
    const result = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      syncStartSec: 1_790_095_300,
      validateRate: validateMetalRate,
    });
    expect(result.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "gold-api.com",
      updatedAt: expected,
    });
  });

  it("re-anchors silver from a corroborated fresh spot when the cached reference is stale", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(okResult({ price: 50.378, updatedAt: "2026-11-02T10:42:22Z" }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 40.448374 },
      prevRateIsFresh: (pegKey) => pegKey !== "peggedSILVER",
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      freshChainlinkRates: { peggedSILVER: 50.39 },
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 50.378,
      source: "gold-api.com",
      updatedAt: Math.floor(Date.parse("2026-11-02T10:42:22Z") / 1000),
    });
  });

  it("keeps gold live and falls back to the clocked cache when silver fails", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(null);

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 40.448374 },
      prevRateIsFresh: () => true,
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedGOLD).toMatchObject({ source: "gold-api.com", rate: 2_900 });
    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 40.448374,
      source: "cached",
      updatedAt: null,
    });
    expect(result.sources).toMatchObject({
      "gold-api.com": "partial",
      "commodity-peer-median": "unavailable",
    });
  });

  it("still vetoes a spot jump against a fresh previous reference", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(okResult({ price: 50.378, updatedAt: "2026-11-02T10:42:22Z" }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 40.448374 },
      prevRateIsFresh: () => true,
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 40.448374,
      source: "cached",
    });
  });

  it("keeps a non-fresh incumbent when a dated spot move has no fresh corroboration", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 5_000, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(okResult({ price: 5.0378, updatedAt: "2026-11-02T10:44:00Z" }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 5_000, peggedSILVER: 40.448374 },
      prevRateIsFresh: () => false,
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      freshChainlinkRates: {},
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 40.448374,
      source: "cached",
      updatedAt: null,
    });
  });

  it("accepts a >20% spot move corroborated by a three-contributor peer median", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(okResult({ price: 50.39, updatedAt: "2026-11-02T10:44:00Z" }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 40.448374 },
      prevRateIsFresh: () => false,
      commodityPeerMedian: {
        rates: { peggedSILVER: 50.5 },
        counts: { peggedSILVER: 3 },
        updatedAt: syncStartSec - 120,
      },
      freshChainlinkRates: {},
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 50.39,
      source: "gold-api.com",
    });
  });

  it("rejects an undated spot move against a stale incumbent", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900 }))
      .mockResolvedValueOnce(okResult({ price: 30 }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 50 },
      prevRateIsFresh: () => false,
      commodityPeerMedian: { rates: {}, counts: {}, updatedAt: null },
      freshChainlinkRates: {},
      syncStartSec,
      validateRate: validateWithPriorDelta,
    });

    expect(result.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 50,
      source: "cached",
      updatedAt: null,
    });
  });

  it("does not admit a commodity peer median with fewer than three contributors", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);

    const thin = await resolveMetalReferenceRates({
      prevRates: {},
      prevRateIsFresh: () => true,
      commodityPeerMedian: {
        rates: { peggedSILVER: 50.5 },
        counts: { peggedSILVER: 2 },
        updatedAt: syncStartSec - 120,
      },
      syncStartSec,
      validateRate: validateMetalRate,
    });
    expect(thin.resolvedByPeg.peggedSILVER).toBeUndefined();

    const broad = await resolveMetalReferenceRates({
      prevRates: {},
      prevRateIsFresh: () => true,
      commodityPeerMedian: {
        rates: { peggedSILVER: 50.5 },
        counts: { peggedSILVER: 3 },
        updatedAt: syncStartSec - 120,
      },
      syncStartSec,
      validateRate: validateMetalRate,
    });
    expect(broad.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 50.5,
      source: "commodity-peer-median",
      updatedAt: syncStartSec - 120,
    });
  });
});


describe("commodity peer observation provenance", () => {
  it.each([null, 1_799_000_000, 1_800_003_600])("rejects missing, stale, or future quotes in a new cache: %s", async (observedAt) => {
    const now = 1_800_000_000;
    const asset = {
      id: "paxg-paxos", name: "Pax Gold", symbol: "PAXG", pegType: "peggedGOLD",
      price: 2900, priceSource: "coingecko", priceObservedAt: observedAt, priceUpdatedAt: now,
      priceObservedAtMode: "upstream", circulating: { peggedGOLD: 10_000_000 },
    };
    const db = mockD1([{ match: "cache", rows: [], first: {
      value: JSON.stringify({ peggedAssets: [asset], fxFallbackRates: {} }), updated_at: now,
    } }]);
    expect(await loadCommodityPeerMedianReference(db, now)).toEqual({ rates: {}, counts: {}, updatedAt: null });
  });

  it("preserves the oldest admitted quote time instead of cache publication time", async () => {
    const now = 1_800_000_000;
    const peggedAssets = [60, 120].map((age, index) => ({
      id: index === 0 ? "paxg-paxos" : "xaut-tether", name: "Gold", symbol: "GOLD", pegType: "peggedGOLD",
      price: 2900, priceSource: "coingecko", priceObservedAt: now - age, priceObservedAtMode: "upstream",
      circulating: { peggedGOLD: 10_000_000 },
    }));
    const db = mockD1([{ match: "cache", rows: [], first: {
      value: JSON.stringify({ peggedAssets, fxFallbackRates: {} }), updated_at: now,
    } }]);
    expect(await loadCommodityPeerMedianReference(db, now)).toEqual({
      rates: { peggedGOLD: 2900 },
      counts: { peggedGOLD: 2 },
      updatedAt: now - 120,
    });
  });

  it("rejects a two-coin silver median and accepts three coins", async () => {
    const now = 1_800_000_000;
    vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(null);
    const silverAsset = (id: string, price: number) => ({
      id, name: "Silver", symbol: id.toUpperCase(), pegType: "peggedSILVER",
      price, priceSource: "coingecko", priceObservedAt: now - 60, priceObservedAtMode: "upstream",
      circulating: { peggedSILVER: 10_000_000 },
    });
    const load = async (assets: ReturnType<typeof silverAsset>[]) => {
      const db = mockD1([{ match: "cache", rows: [], first: {
        value: JSON.stringify({ peggedAssets: assets, fxFallbackRates: {} }), updated_at: now,
      } }]);
      return await loadCommodityPeerMedianReference(db, now);
    };

    const thin = await load([silverAsset("silver-a", 50), silverAsset("silver-b", 51)]);
    expect(thin).toEqual({ rates: { peggedSILVER: 50.5 }, counts: { peggedSILVER: 2 }, updatedAt: now - 60 });
    const thinResolved = await resolveMetalReferenceRates({
      prevRates: {},
      prevRateIsFresh: () => true,
      commodityPeerMedian: thin,
      syncStartSec: now,
      validateRate: validateMetalRate,
    });
    expect(thinResolved.resolvedByPeg.peggedSILVER).toBeUndefined();

    const broad = await load([
      silverAsset("silver-a", 50),
      silverAsset("silver-b", 50.5),
      silverAsset("silver-c", 51),
    ]);
    const broadResolved = await resolveMetalReferenceRates({
      prevRates: {},
      prevRateIsFresh: () => true,
      commodityPeerMedian: broad,
      syncStartSec: now,
      validateRate: validateMetalRate,
    });
    expect(broadResolved.resolvedByPeg.peggedSILVER).toMatchObject({
      rate: 50.5,
      source: "commodity-peer-median",
      updatedAt: now - 60,
    });
  });
});
