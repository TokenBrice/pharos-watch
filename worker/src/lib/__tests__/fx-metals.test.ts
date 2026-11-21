import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonWithRetry } from "../fetch-retry";
import { isValidFxRate } from "../fx-config";
import { loadCommodityPeerMedianReference, resolveMetalReferenceRates, type MetalPegKey } from "../fx-metals";
import { evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { FxSyncRunState } from "../../cron/sync-fx-rates-helpers";
import { getFxReferenceTypeFromState, loadFxRateState, persistFxRateState } from "../fx-rate-state";

const validateMetalRate = (pegKey: MetalPegKey, rate: number): boolean =>
  pegKey === "peggedGOLD"
    ? rate >= 500 && rate <= 10_000
    : rate >= 5 && rate <= 500;

const validateWithPriorDelta = (pegKey: MetalPegKey, rate: number, prevRate: number | undefined): boolean =>
  isValidFxRate(pegKey, rate, prevRate, "[fx-metals-test]");

function okResult(body: Record<string, unknown>) {
  return { response: new Response(JSON.stringify(body), { status: 200 }), body };
}

const silverContributors = (observedAtSec: number) => ["silver-a", "silver-b", "silver-c"].map((assetId) => ({
  assetId, observedAtSec, provenanceKey: "coingecko", derivation: "spot-derived" as const,
}));

describe("resolveMetalReferenceRates", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(() => fixtures.closeAll());
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
  });

  it.each([
    [null, 60, 2_910, "peer-median"],
    ["2026-11-02T10:44:00Z", 86_400, 3_110, "gold-api.com"],
  ] as const)("uses the in-budget metal evidence with spot time %s and oldest peer age %d", async (spotTime, peerAge, spotPrice, source) => {
    const now = Date.parse("2026-11-02T10:45:00Z") / 1000;
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce(okResult({ price: spotPrice, ...(spotTime ? { updatedAt: spotTime } : {}) }))
      .mockResolvedValueOnce(null);
    const contributors = silverContributors(now - 30).map((c, i) => ({ ...c, observedAtSec: i === 0 ? now - peerAge : c.observedAtSec }));
    const resolved = await resolveMetalReferenceRates({
      syncStartSec: now, validateRate: validateMetalRate, prevRates: {},
      commodityPeerMedian: { rates: { peggedGOLD: 2900 }, counts: { peggedGOLD: 3 }, contributorsByPeg: { peggedGOLD: contributors } },
    });
    const run = new FxSyncRunState({ syncStartSec: now, expectedPegKeys: ["peggedGOLD"], prevState: null,
      validateRate: () => true, initialSources: {} });
    // A prior direct observation in this session supplies the independent repricing anchor for spot.
    run.usableRates.peggedGOLD = 2900;
    run.markLive("peggedGOLD", now - 3 * 3600, "intraday", null, "gold-api.com");
    run.markLive("peggedGOLD", now - 2 * 3600, "intraday", null, "gold-api.com");
    run.applyResolvedMetals(resolved);
    const { db } = fixtures.open();
    const meta = run.buildPersistedMeta();
    expect(meta.directMetalReferences?.peggedGOLD).toMatchObject({
      observation: { source: "gold-api.com", observedAtSec: spotTime ? now - 60 : now - 2 * 3600 },
      generation: `fx:${now}`, firstInSessionObservedAtSec: now - 3 * 3600,
    });
    await persistFxRateState(db, run.usableRates, meta, now);
    const hydrated = await loadFxRateState(db);
    const observation = hydrated!.selectedReferenceEvidence!.peggedGOLD;
    expect(observation.source).toBe(source);
    expect(observation.observedAtSec).toBe(now - 60);
    expect(getFxReferenceTypeFromState(hydrated, "peggedGOLD", 21600, now)).toBe("fresh");
    const common = { decisionAtSec: now, quoteObservedAtSec: now, rawDeviationBps: asRawDeviationBps(0) };
    const verdict = observation.source === "peer-median"
      ? evaluateReferenceAdmission({ ...common, kind: "median", pegKey: observation.pegKey, contributors: observation.contributors! })
      : evaluateReferenceAdmission({ ...common, kind: "fallback", observation, ...observation.repricing });
    expect(verdict.reason).toBe("live-reference");
  });

  it.each([
    ["2026-11-21T08:00:00Z", 3600, true],
    ["2026-11-21T08:00:00Z", 7 * 3600, false],
    ["2026-11-23T01:00:00Z", 3600, false],
  ] as const)("at %s keeps the closed session's live gold benchmark taken %is before the close: %s", (now, beforeClose, kept) => {
    const close = Date.parse("2026-11-20T22:00:00Z") / 1000;
    const run = new FxSyncRunState({ syncStartSec: Date.parse(now) / 1000, expectedPegKeys: ["peggedGOLD"], prevState: null,
      validateRate: () => true, initialSources: {} });
    run.usableRates.peggedGOLD = 2900;
    run.markLive("peggedGOLD", close - beforeClose - 2 * 3600, "intraday", null, "gold-api.com");
    run.markLive("peggedGOLD", close - beforeClose, "intraday", null, "gold-api.com");
    expect(run.buildPersistedMeta().directMetalReferences?.peggedGOLD?.observation.observedAtSec)
      .toBe(kept ? close - beforeClose : undefined);
  });

  it("does not carry forward cached metal rates outside current bounds", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 100, peggedSILVER: 1_000 },
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
      commodityPeerMedian: { rates: { peggedGOLD: 2_900 }, counts: { peggedGOLD: 3 }, contributorsByPeg: {} },
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
  ])("preserves actual provider time without refreshing it: %s", async (updatedAt, expected) => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      body: { price: 2_900, updatedAt },
    });
    const result = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
      syncStartSec: 1_790_095_300,
      validateRate: validateMetalRate,
    });
    expect(result.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "gold-api.com",
      updatedAt: expected,
    });
  });

  it("keeps the cached fallback when the spot clock is ahead of the generation", async () => {
    const syncStartSec = 1_800_000_000;
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce(okResult({
      price: 2950, updatedAt: new Date((syncStartSec + 1) * 1000).toISOString(),
    })).mockResolvedValueOnce(null);
    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2900 },
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
      syncStartSec,
      validateRate: validateMetalRate,
    });
    expect(result.resolvedByPeg.peggedGOLD).toEqual({ rate: 2900, source: "cached", updatedAt: null });
    expect(result.sources["gold-api.com"]).toBe("error");
  });

  it("re-anchors silver from a corroborated fresh spot when the cached reference is stale", async () => {
    const syncStartSec = Math.floor(Date.parse("2026-11-02T10:45:00Z") / 1000);
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce(okResult({ price: 2_900, updatedAt: "2026-11-02T10:44:00Z" }))
      .mockResolvedValueOnce(okResult({ price: 50.378, updatedAt: "2026-11-02T10:42:22Z" }));

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 2_900, peggedSILVER: 40.448374 },
      prevRateIsFresh: (pegKey) => pegKey !== "peggedSILVER",
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
        contributorsByPeg: { peggedSILVER: silverContributors(syncStartSec - 120) },
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
      commodityPeerMedian: { rates: {}, counts: {}, contributorsByPeg: {} },
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
        contributorsByPeg: { peggedSILVER: silverContributors(syncStartSec - 120) },
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
        contributorsByPeg: { peggedSILVER: silverContributors(syncStartSec - 120) },
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
  it.each([null, 1_799_000_000, 1_800_000_001])("rejects missing, stale, or future quotes in a new cache: %s", async (observedAt) => {
    const now = 1_800_000_000;
    const asset = {
      id: "paxg-paxos", name: "Pax Gold", symbol: "PAXG", pegType: "peggedGOLD",
      price: 2900, priceSource: "coingecko", priceObservedAt: observedAt, priceUpdatedAt: now,
      priceObservedAtMode: "upstream", circulating: { peggedGOLD: 10_000_000 },
    };
    const db = mockD1([{ match: "cache", rows: [], first: {
      value: JSON.stringify({ peggedAssets: [asset], fxFallbackRates: {} }), updated_at: now,
    } }]);
    expect(await loadCommodityPeerMedianReference(db, now)).toEqual({ rates: {}, counts: {}, contributorsByPeg: {} });
  });

  it.each(["kraken", "kraken+coingecko"])("keeps the fetch-stamped %s quote out of the closure quorum", async (third) => {
    const now = Date.parse("2026-11-14T12:00:00Z") / 1000;
    // Kraken's adapter can return an undated last trade when the bid or ask is missing.
    // The published price has a fetch clock and no quote-level book evidence in that case.
    const rows = [
      ["coinbase", "upstream"], ["bitstamp", "upstream"], [third, "local_fetch"],
      ["chainlink-nav", "upstream"], ["kava-pricefeed", "upstream"],
    ] as const;
    const peggedAssets = rows.map(([priceSource, priceObservedAtMode], index) => ({
      id: `gold-${index}`, name: "Gold", symbol: "GOLD", pegType: "peggedGOLD", price: 2900 + index,
      priceSource, priceObservedAtMode, priceObservedAt: now - 60, circulating: { peggedGOLD: 10_000_000 },
    }));
    const db = mockD1([{ match: "cache", rows: [], first: {
      value: JSON.stringify({ peggedAssets, fxFallbackRates: {} }), updated_at: now,
    } }]);
    const median = await loadCommodityPeerMedianReference(db, now);
    const contributors = median.contributorsByPeg.peggedGOLD!;
    expect(contributors.map(({ derivation }) => derivation)).toEqual(["traded-market", "traded-market", "spot-derived", "nav", "oracle"]);
    expect(contributors.map(({ provenanceKey }) => provenanceKey).slice(0, 3)).toEqual([
      "market:coinbase", "market:bitstamp", third === "kraken" ? "market:kraken" : third,
    ]);
    expect(evaluateReferenceAdmission({
      kind: "median", pegKey: "peggedGOLD", contributors,
      decisionAtSec: now, quoteObservedAtSec: now, rawDeviationBps: asRawDeviationBps(0),
    }).reason).toBe("reference-market-closed");
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
      contributorsByPeg: { peggedGOLD: peggedAssets.map((asset) => ({
        assetId: asset.id, observedAtSec: asset.priceObservedAt, observedAtMode: "upstream", provenanceKey: "coingecko", derivation: "spot-derived",
      })) },
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
    expect(thin.counts.peggedSILVER).toBe(2);
    expect(thin.contributorsByPeg.peggedSILVER).toHaveLength(2);
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
      silverAsset("silver-b", 50.50000049),
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
      rate: 50.50000049,
      source: "commodity-peer-median",
      updatedAt: now - 60,
    });
  });
});
