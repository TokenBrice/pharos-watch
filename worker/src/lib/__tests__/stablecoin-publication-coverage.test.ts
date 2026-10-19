import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  STABLECOIN_PRICE_GAP_REVIEWS,
  resolveStablecoinPriceGapReviews,
  classifyStablecoinPublicationGap,
  compactStablecoinActivePriceCoverage,
  parsePersistedMissingActivePriceState,
  evaluateStablecoinActivePriceCoverage,
  evaluateStablecoinPublicationCoverage,
  loadPreviousStablecoinActivePriceCoverage,
  seedAbsentActivePriceCoverageMarketCaps,
} from "../stablecoin-publication-coverage";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC } from "@shared/lib/status-thresholds";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const QUARANTINED_NIGHT_WATCH_OMISSIONS = [
  "benji-franklin-templeton",
  "wtgxx-wisdomtree",
  "busd0-usual",
  "tbill-openeden",
  "cetes-etherfuse",
  "jusd-jusd-stable-token",
  "vndc-jade-labs",
  // sofid-sofi left this list on 2026-09-29: CoinGecko market cap and the
  // DefiLlama 430 row restored a positive supply path, so it is active again.
  "gramg-token-teknoloji",
  "grams-token-teknoloji",
] as const;

describe("evaluateStablecoinPublicationCoverage", () => {
  const nowSec = Date.UTC(2026, 6, 10) / 1000;
  const activeIds = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);

  it("excludes reviewed no-supply records from the active coverage contract", () => {
    expect(activeIds.filter((id) => QUARANTINED_NIGHT_WATCH_OMISSIONS.includes(
      id as (typeof QUARANTINED_NIGHT_WATCH_OMISSIONS)[number],
    ))).toEqual([]);
    expect(evaluateStablecoinPublicationCoverage(activeIds, nowSec)).toMatchObject({
      complete: true,
      expectedActiveCount: activeIds.length,
      presentActiveCount: activeIds.length,
      waivedActiveCount: 0,
    });
  });

  it("has no default publication waivers", () => {
    expect(STABLECOIN_PUBLICATION_WAIVERS).toEqual([]);
  });

  it("accepts only owned, reasoned, unexpired waivers", () => {
    const missingId = activeIds[0]!;
    const present = activeIds.filter((id) => id !== missingId);

    expect(evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "data-operations",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec + 3600,
    }]).complete).toBe(true);

    const expired = evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "data-operations",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec,
    }]);
    expect(expired.complete).toBe(false);
    expect(expired.expiredWaiverIds).toContain(missingId);

    const unowned = evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec + 3600,
    }]);
    expect(unowned.complete).toBe(false);
    expect(unowned.invalidWaiverIds).toContain(missingId);
  });

});

describe("classifyStablecoinPublicationGap", () => {
  it.each([
    [400, 0, "none"],
    [400, 3, "routine"],
    [400, 4, "elevated"],
    [400, 40, "elevated"],
    [400, 41, "systemic"],
    [0, 0, "none"],
    [0, 1, "systemic"],
  ] as const)("classifies %i expected with %i missing as %s", (expectedActiveCount, missingCount, band) => {
    const missingActiveIds = Array.from({ length: missingCount }, (_, index) => `missing-${index}`);
    expect(classifyStablecoinPublicationGap({ expectedActiveCount, missingActiveIds })).toBe(band);
  });
});

describe("evaluateStablecoinActivePriceCoverage", () => {
  it.each([
    { caps: [100, 200], total: 300 },
    { caps: [100, null], total: null },
    { caps: [null, null], total: null },
    { caps: [0, 0], total: 0 },
  ])("preserves missing-price aggregate cap availability for $caps", ({ caps, total }) => {
    const assets = caps.map((cap, index) => ({
      id: `asset-${index}`, price: null, ...(cap == null ? {} : { circulating: { peggedUSD: cap } }),
    }));
    const coverage = evaluateStablecoinActivePriceCoverage(assets, assets.map((asset) => asset.id));
    expect(coverage.affectedMarketCapUsd).toBe(total);
    expect(coverage.missingActiveAssets.map((asset) => asset.marketCapUsd)).toEqual(caps);
  });
  it("keeps nominal market-cap availability distinct from zero and missing prices", () => {
    const reference = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
    const circulatingCases: Array<Record<string, number> | undefined> = [undefined, {}, { peggedUSD: 0 }, { peggedUSD: 125 }];
    for (const circulating of circulatingCases) {
      const coverage = evaluateStablecoinActivePriceCoverage([{
        id: "nominal", price: 1, priceObservedAtMode: "nominal_reference" as const,
        nominalPriceReference: reference, circulating,
      }], ["nominal"]);
      expect(coverage).toMatchObject({
        complete: true, pricedActiveCount: 0, missingPriceCount: 0,
        nominalReferenceCount: 1, nominalReferenceIds: ["nominal"],
        nominalReferenceMarketCapUsd: circulating?.peggedUSD ?? null,
        nominalReferenceReason: "reviewed-nominal-reference",
        alertEligibleCount: 0, maxConsecutiveMissingGenerations: 0,
      });
    }
  });
  it("reports missing prices independently from complete row coverage", () => {
    const coverage = evaluateStablecoinActivePriceCoverage([
      {
        id: "priced",
        price: 1,
        priceSource: "pyth",
        priceObservedAt: 1_700_000_000,
        circulating: { peggedUSD: 200 },
      },
      {
        id: "missing",
        price: null,
        priceSource: "coingecko",
        priceUpdatedAt: 1_699_000_000,
        priceConfidence: "low",
        circulating: { peggedUSD: 125.5 },
      },
    ], ["priced", "missing"], { priceGapReviews: [] });

    expect(coverage).toMatchObject({
      complete: false,
      expectedActiveCount: 2,
      presentActiveCount: 2,
      pricedActiveCount: 1,
      missingPriceCount: 1,
      pricedActiveIds: ["priced"],
      missingActiveIds: ["missing"],
      affectedMarketCapUsd: 125.5,
      missingActiveAssets: [{
        stablecoinId: "missing",
        symbol: "missing",
        marketCapUsd: 125.5,
        currentPrice: null,
        currentSource: "coingecko",
        currentObservedAt: 1_699_000_000,
        currentConfidence: "low",
        consecutiveMissingGenerations: 1,
        lastAcceptedPrice: null,
        lastAcceptedSource: null,
        lastAcceptedObservedAt: null,
        rejectionReason: "no-accepted-price",
        alertEligible: false,
        acknowledgedGap: null,
      }],
      alertEligibleCount: 0,
      alertEligibleIds: [],
      acknowledgedGapIds: [],
      acknowledgedGapCount: 0,
      expiredGapReviewIds: [],
      invalidGapReviewIds: [],
      maxConsecutiveMissingGenerations: 1,
    });
  });

  it("treats a missing row and non-positive prices as uncovered", () => {
    const coverage = evaluateStablecoinActivePriceCoverage([
      { id: "zero", price: 0 },
      { id: "negative", price: -1 },
    ], ["zero", "negative", "absent"]);

    expect(coverage.presentActiveCount).toBe(2);
    expect(coverage.pricedActiveCount).toBe(0);
    expect(coverage.missingActiveIds).toEqual(["zero", "negative", "absent"]);
    expect(coverage.missingActiveAssets[2]).toMatchObject({
      stablecoinId: "absent",
      marketCapUsd: null,
      currentPrice: null,
    });
  });

  it("carries the last accepted observation and alerts on the second missing generation", () => {
    const previousAcceptedAssetsById = new Map([[
      "missing",
      {
        id: "missing",
        symbol: "MISS",
        price: 0.998,
        priceSource: "pyth",
        priceObservedAt: 1_700_000_000,
      },
    ]]);
    const first = evaluateStablecoinActivePriceCoverage(
      [{ id: "missing", symbol: "MISS", price: null }],
      ["missing"],
      { previousAcceptedAssetsById },
    );
    const second = evaluateStablecoinActivePriceCoverage(
      [{ id: "missing", symbol: "MISS", price: null }],
      ["missing"],
      {
        previousCoverage: first,
        previousAcceptedAssetsById: new Map([[
          "missing",
          { id: "missing", symbol: "MISS", price: null },
        ]]),
      },
    );

    expect(first.missingActiveAssets[0]).toMatchObject({
      symbol: "MISS",
      consecutiveMissingGenerations: 1,
      lastAcceptedPrice: 0.998,
      lastAcceptedSource: "pyth",
      lastAcceptedObservedAt: 1_700_000_000,
      alertEligible: false,
    });
    expect(second).toMatchObject({
      alertEligibleCount: 1,
      alertEligibleIds: ["missing"],
      maxConsecutiveMissingGenerations: 2,
    });
    expect(second.missingActiveAssets[0]).toMatchObject({
      consecutiveMissingGenerations: 2,
      lastAcceptedPrice: 0.998,
      lastAcceptedSource: "pyth",
      lastAcceptedObservedAt: 1_700_000_000,
      rejectionReason: "no-accepted-price",
      alertEligible: true,
    });
  });

  it("seeds absent-row cap from the previous publication and carries its original clock through compact generations", () => {
    const nowSec = 1_790_000_000;
    const first = evaluateStablecoinActivePriceCoverage([], ["missing"], {
      nowSec,
      previousAcceptedAssetsById: new Map([["missing", {
        id: "missing", price: 1.019, priceSource: "coingecko",
        circulating: { peggedUSD: 12_000_000 }, supplyObservedAt: nowSec - 900,
      }]]),
    });
    const compact = compactStablecoinActivePriceCoverage(first, 0);
    const detail = parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec })!;
    const second = evaluateStablecoinActivePriceCoverage([], ["missing"], {
      nowSec: nowSec + 900, previousCoverage: { missingActiveIds: ["missing"], missingActiveAssets: [detail] },
    });
    expect(second.missingActiveAssets[0]).toMatchObject({
      marketCapUsd: null, lastKnownMarketCapUsd: 12_000_000,
      lastKnownMarketCapObservedAt: nowSec - 900, lastKnownMarketCapSource: "publication",
      consecutiveMissingGenerations: 2,
    });
  });

  it("seeds legacy prior-gap cap only with its publication clock", () => {
    const nowSec = 1_790_000_000;
    const previous = evaluateStablecoinActivePriceCoverage([
      { id: "missing", price: null, circulating: { peggedUSD: 5_000_000 } },
    ], ["missing"], { nowSec: nowSec - 900 });
    delete previous.missingActiveAssets[0]!.lastKnownMarketCapUsd;
    delete previous.missingActiveAssets[0]!.lastKnownMarketCapObservedAt;
    const next = evaluateStablecoinActivePriceCoverage([], ["missing"], {
      nowSec, previousCoverage: { ...previous, observedAt: nowSec - 900 },
    });
    expect(next.missingActiveAssets[0]).toMatchObject({
      marketCapUsd: null, lastKnownMarketCapUsd: 5_000_000,
      lastKnownMarketCapObservedAt: nowSec - 900,
    });
  });

  it("preserves current cap separately from retained evidence in compact coverage", () => {
    const nowSec = 1_790_000_000;
    const coverage = evaluateStablecoinActivePriceCoverage([
      { id: "unpriced", price: null, circulating: { peggedUSD: 60_000_000 } },
    ], ["unpriced"], { nowSec });
    const compact = compactStablecoinActivePriceCoverage(coverage, 0);
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec })).toMatchObject({
      marketCapUsd: 60_000_000, lastKnownMarketCapUsd: 60_000_000, lastKnownMarketCapObservedAt: nowSec,
    });
  });

  it("bootstraps only absent rows from one bounded supply snapshot read and carries table/date provenance", async () => {
    const nowSec = 1_790_000_000;
    const coverage = evaluateStablecoinActivePriceCoverage([{ id: "unpriced", price: null }], ["missing", "unpriced"], { nowSec });
    const db = mockD1([{
      match: "JOIN supply_history", rows: [
        { stablecoin_id: "missing", snapshot_date: nowSec - 11 * 86400, circulating_usd: 32_686_926.18 },
      ],
    }]);
    await seedAbsentActivePriceCoverageMarketCaps(db, coverage, nowSec);
    expect(coverage.missingActiveAssets[0]).toMatchObject({
      marketCapUsd: null, lastKnownMarketCapUsd: 32_686_926.18,
      lastKnownMarketCapObservedAt: nowSec - 11 * 86400, lastKnownMarketCapSource: "supply_history",
    });
    const next = evaluateStablecoinActivePriceCoverage([], ["missing"], { nowSec: nowSec + 900, previousCoverage: coverage });
    expect(next.missingActiveAssets[0]).toMatchObject({
      lastKnownMarketCapUsd: 32_686_926.18, lastKnownMarketCapObservedAt: nowSec - 11 * 86400,
      lastKnownMarketCapSource: "supply_history",
    });
    const noReadDb = mockD1([]);
    const prepare = vi.spyOn(noReadDb, "prepare");
    await seedAbsentActivePriceCoverageMarketCaps(noReadDb, next, nowSec + 900);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("selects only the latest bounded non-future supply snapshot for absent ids", async () => {
    const nowSec = 1_790_000_000;
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)");
    insert.run("fresh", nowSec - 900, 32_686_926.18);
    insert.run("fresh", nowSec - 1800, 31_000_000);
    insert.run("fresh", nowSec + 900, 10_000_000);
    insert.run("stale", nowSec - STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC - 1, 5_000_000);
    insert.run("unpriced", nowSec - 900, 5_000_000);
    const coverage = evaluateStablecoinActivePriceCoverage([{ id: "unpriced", price: null }],
      ["fresh", "stale", "absent", "unpriced"], { nowSec });
    await seedAbsentActivePriceCoverageMarketCaps(db, coverage, nowSec);
    expect(coverage.missingActiveAssets.map((gap) => gap.lastKnownMarketCapUsd)).toEqual([
      32_686_926.18, null, null, null,
    ]);
    expect(coverage.missingActiveAssets[0]?.lastKnownMarketCapObservedAt).toBe(nowSec - 900);
  });

  it("retains unknown compact continuity and still honors review expiry", async () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
    const first = evaluateStablecoinActivePriceCoverage(
      [{ id: review.stablecoinId, price: null }], [review.stablecoinId],
      {
        previousCoverage: { missingActiveIds: [], missingActiveAssets: [], unavailableReason: "previous-coverage-read-failed" },
        nowSec: review.expiresAt - 1,
      },
    );
    const compact = compactStablecoinActivePriceCoverage(first, 0);
    expect(compact.missingActiveState[0][1]).toBeNull();
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.expiresAt - 1 }))
      .toMatchObject({ consecutiveMissingGenerations: null, alertEligible: false, streakUnavailableReason: "previous-coverage-read-failed" });
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.expiresAt }))
      .toMatchObject({ consecutiveMissingGenerations: null, alertEligible: true, acknowledgedGap: null });
    const prior = await loadPreviousStablecoinActivePriceCoverage(mockD1([{
      match: "activePriceCoverage", rows: [],
      first: { metadata: JSON.stringify({ activePriceCoverage: compact }) },
    }]), review.expiresAt);
    expect(prior.status).toBe("ok");
    if (prior.status !== "ok") throw new Error("Expected readable compact continuity");
    const next = evaluateStablecoinActivePriceCoverage(
      [{ id: review.stablecoinId, price: null }], [review.stablecoinId],
      { previousCoverage: prior.coverage, nowSec: review.expiresAt },
    );
    expect(next.missingActiveAssets[0]).toMatchObject({ consecutiveMissingGenerations: null, alertEligible: true });
  });

  it.each(["wusd-worldwide", "pht-pht", "vcred-vcred", "hbd-hive", "usdn-noble", "usdk-kast"])("keeps %s missing while acknowledged, re-alerts at expiry, and clears on a real price", (id) => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
    const ids = [review.stablecoinId, "usdt-tether"];
    const first = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } })),
      ids,
      { nowSec: review.reviewedAt, priceGapReviews: [review] },
    );
    first.missingActiveAssets.forEach((asset) => { asset.consecutiveMissingGenerations = 800; });
    const acknowledged = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } })),
      ids,
      { nowSec: review.expiresAt - 1, priceGapReviews: [review], previousCoverage: first },
    );
    expect(acknowledged).toMatchObject({
      complete: false,
      missingPriceCount: 2,
      missingActiveIds: ids,
      affectedMarketCapUsd: 200,
      alertEligibleIds: ["usdt-tether"],
      acknowledgedGapIds: [review.stablecoinId],
      acknowledgedGapCount: 1,
    });
    expect(acknowledged.missingActiveAssets[0]).toMatchObject({
      alertEligible: false,
      consecutiveMissingGenerations: 801,
      acknowledgedGap: { owner: "ops", expiresAt: review.expiresAt },
    });
    const compact = compactStablecoinActivePriceCoverage(acknowledged, 0);
    const restored = parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.expiresAt - 1 });
    expect(restored).toMatchObject({ alertEligible: false, consecutiveMissingGenerations: 801 });
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.expiresAt }))
      .toMatchObject({ alertEligible: true, acknowledgedGap: null });

    const expired = evaluateStablecoinActivePriceCoverage(ids.map((id) => ({ id, price: null })), ids, {
      nowSec: review.expiresAt,
      priceGapReviews: [review],
      previousCoverage: acknowledged,
    });
    expect(expired.alertEligibleIds).toEqual(ids);
    expect(expired.expiredGapReviewIds).toEqual([review.stablecoinId]);
    expect(expired.acknowledgedGapIds).toEqual([]);

    const priced = evaluateStablecoinActivePriceCoverage(ids.map((id) => ({ id, price: 0.7 })), ids, {
      nowSec: review.expiresAt - 1,
      priceGapReviews: [review],
      previousCoverage: acknowledged,
    });
    expect(priced).toMatchObject({ complete: true, pricedActiveIds: ids, acknowledgedGapCount: 0, missingPriceCount: 0 });
  });

  it("excludes frozen USDKG from the active census even when upstream retains its row", () => {
    const id = "usdkg-gold-dollar";
    const activeIds = ACTIVE_STABLECOINS.map((coin) => coin.id);
    expect(activeIds).not.toContain(id);
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
    const coverage = evaluateStablecoinActivePriceCoverage([
      ...activeIds.map((activeId) => ({ id: activeId, price: 1 })),
      { id, price: null, circulating: { peggedUSD: 50_000_000 } },
    ], activeIds, { nowSec: Date.UTC(2026, 9, 19, 12) / 1000 });
    expect(coverage).toMatchObject({ complete: true, missingPriceCount: 0 });
    expect(coverage.pricedActiveIds).not.toContain(id);
    expect(coverage.missingActiveIds).not.toContain(id);
    expect(coverage.invalidGapReviewIds).not.toContain(id);
    expect(coverage.expiredGapReviewIds).not.toContain(id);
  });

  it("bounds the M0-family source-gap reviews to seven days without waiving publication or inventing prices", () => {
    const ids = ["usdn-noble", "usdk-kast"];
    const reviews = STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => ids.includes(entry.stablecoinId));
    expect(reviews.map((review) => review.stablecoinId)).toEqual(ids);
    for (const review of reviews) {
      expect(review.owner).toBe("ops");
      expect(review.reviewedAt).toBe(Date.UTC(2026, 9, 19, 2, 35, 17) / 1000);
      expect(review.expiresAt).toBeGreaterThan(review.reviewedAt);
      expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(7 * 86_400);
      expect(review.reason).toContain("2026-10-19 00:39:33 UTC");
      expect(review.reason).toContain("15-minute");
      expect(review.reason).toContain("inherit");
      expect(review.reason).toContain("fallback-confidence");
      expect(review.reason).toContain("not observed prices");
      expect(review.sources.some((source) => source.includes("api.coingecko.com/"))).toBe(true);
      expect(review.sources.some((source) => source.includes("stablecoins.llama.fi/"))).toBe(true);
      expect(review.sources.some((source) => source.includes("api.dexscreener.com/"))).toBe(true);
      expect(review.sources.some((source) => source.includes("api.geckoterminal.com/"))).toBe(true);
      expect(review.sources.every((source) => /^https:\/\/\S+$/.test(source))).toBe(true);
    }
    const assets = ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } }));
    const nowSec = reviews[0]!.reviewedAt;
    const coverage = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec, priceGapReviews: reviews });
    expect(coverage).toMatchObject({
      complete: false,
      missingPriceCount: 2,
      missingActiveIds: ids,
      acknowledgedGapIds: ids,
      alertEligibleIds: [],
      pricedActiveIds: [],
      invalidGapReviewIds: [],
      expiredGapReviewIds: [],
    });
    expect(assets.every((asset) => asset.price === null)).toBe(true);
    const publication = evaluateStablecoinPublicationCoverage([], nowSec, STABLECOIN_PUBLICATION_WAIVERS, ids);
    expect(publication).toMatchObject({ complete: false, missingActiveIds: ids, waivedActiveIds: [] });
  });

  it("acknowledges all five reviewed Mento weekend FX-closure gaps without inventing prices", () => {
    const ids = ["cadm-mento", "audm-mento", "chfm-mento", "copm-mento", "jpym-mento"];
    const mentoReviews = STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => ids.includes(entry.stablecoinId));
    expect(mentoReviews).toHaveLength(ids.length);
    for (const review of mentoReviews) {
      expect(review.owner).toBe("ops");
      expect(review.reason).toMatch(/weekend/i);
      expect(review.sources.length).toBeGreaterThanOrEqual(1);
      expect(review.sources.every((source) => /^https:\/\/\S+$/.test(source))).toBe(true);
      expect(review.expiresAt).toBeGreaterThan(review.reviewedAt);
      expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(30 * 86_400);
      expect(review.weeklyUtcWindow).toEqual({ start: 5 * 86_400 + 21 * 3600, end: 23 * 3600 });
    }

    const assets = ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } }));
    const fridayClose = evaluateStablecoinActivePriceCoverage(assets, ids, {
      nowSec: Date.UTC(2026, 9, 23, 21, 30) / 1000, priceGapReviews: mentoReviews,
    });
    const saturday = evaluateStablecoinActivePriceCoverage(assets, ids, {
      nowSec: Date.UTC(2026, 9, 24, 12) / 1000, priceGapReviews: mentoReviews, previousCoverage: fridayClose,
    });
    expect(saturday).toMatchObject({
      complete: false,
      pricedActiveCount: 0,
      missingPriceCount: ids.length,
      missingActiveIds: ids,
      alertEligibleIds: [],
      alertEligibleCount: 0,
      acknowledgedGapIds: ids,
      acknowledgedGapCount: ids.length,
    });
    expect(saturday.missingActiveAssets.every((asset) => asset.consecutiveMissingGenerations === 2 && !asset.alertEligible)).toBe(true);

    const mondayReopen = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: 1.2 })),
      ids,
      { nowSec: Date.UTC(2026, 9, 26, 0, 15) / 1000, priceGapReviews: mentoReviews, previousCoverage: saturday },
    );
    expect(mondayReopen).toMatchObject({
      complete: true,
      pricedActiveIds: ids,
      missingPriceCount: 0,
      acknowledgedGapCount: 0,
    });
  });

  it.each(["cadm-mento", "audm-mento", "chfm-mento", "copm-mento", "jpym-mento"])(
    "limits %s acknowledgement to its reviewed weekly UTC closure and expiry",
    (id) => {
      const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
      // Exercise a real weekend inside each review, without evaluating before its review date.
      const sunday = Date.UTC(2026, 9, id === "cadm-mento" || id === "audm-mento" ? 25 : 18) / 1000;
      for (const [nowSec, active] of [
        [sunday - 2 * 86_400 + 21 * 3600 - 1, false],
        [sunday - 2 * 86_400 + 21 * 3600, true],
        [sunday + 23 * 3600 - 1, true],
        [sunday + 23 * 3600, false],
        [sunday + 86_400 + 12 * 3600, false],
        [review.expiresAt - 1, true],
        [review.expiresAt, false],
      ] as const) {
        expect([...resolveStablecoinPriceGapReviews([id], nowSec, [review]).activeById.keys()]).toEqual(active ? [id] : []);
      }
      const assets = [{ id, price: null, circulating: { peggedUSD: 100 } }];
      const closed = evaluateStablecoinActivePriceCoverage(assets, [id], {
        nowSec: sunday + 22 * 3600, priceGapReviews: [review],
      });
      for (const nowSec of [sunday + 23 * 3600, review.expiresAt]) {
        const unacknowledged = evaluateStablecoinActivePriceCoverage(assets, [id], {
          nowSec, priceGapReviews: [review], previousCoverage: closed,
        });
        expect(unacknowledged.missingActiveIds).toEqual([id]);
        expect(unacknowledged.acknowledgedGapIds).toEqual([]);
        expect(unacknowledged.alertEligibleIds).toEqual([id]);
        expect(unacknowledged.expiredGapReviewIds).toEqual(nowSec === review.expiresAt ? [id] : []);
      }
    },
  );

  it("retires the recovered TRYB review while acknowledging active PHT and VCRED", () => {
    const ids = ["tryb-bilira", "pht-pht", "vcred-vcred"];
    const reviews = STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => ids.includes(entry.stablecoinId));
    expect(reviews.map((review) => review.stablecoinId).sort()).toEqual(["pht-pht", "vcred-vcred"]);
    const nowSec = Date.UTC(2026, 9, 19) / 1000;
    const coverage = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: id === "tryb-bilira" ? 0.0203935242416747 : null })),
      ids,
      { nowSec, priceGapReviews: reviews },
    );
    expect(coverage).toMatchObject({
      pricedActiveIds: ["tryb-bilira"],
      missingActiveIds: ["pht-pht", "vcred-vcred"],
      acknowledgedGapIds: ["pht-pht", "vcred-vcred"],
      expiredGapReviewIds: [],
      invalidGapReviewIds: [],
      alertEligibleIds: [],
    });
    for (const review of reviews) {
      expect(review.reviewedAt).toBeLessThanOrEqual(nowSec);
      expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(7 * 86_400);
      expect(review.expiresAt - nowSec).toBeGreaterThan(48 * 3600);
    }
    const firstGap = evaluateStablecoinActivePriceCoverage([{ id: "tryb-bilira", price: null }], ["tryb-bilira"], {
      nowSec, priceGapReviews: [],
    });
    const missingAgain = evaluateStablecoinActivePriceCoverage([{ id: "tryb-bilira", price: null }], ["tryb-bilira"], {
      nowSec: nowSec + 900, priceGapReviews: [], previousCoverage: firstGap,
    });
    expect(missingAgain.alertEligibleIds).toEqual(["tryb-bilira"]);
    expect(missingAgain.acknowledgedGapIds).toEqual([]);
  });

  it("fails closed on malformed review ownership, evidence, identity, and dates", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS[0]!;
    const invalidReviews = [
      { ...review, owner: "" },
      { ...review, reason: " " },
      { ...review, sources: [] },
      { ...review, sources: ["http://example.com"] },
      { ...review, expiresAt: review.reviewedAt },
      { ...review, reviewedAt: Number.NaN },
      { ...review, stablecoinId: "inactive-unknown" },
      { ...review, weeklyUtcWindow: { start: -1, end: 1 } },
      { ...review, weeklyUtcWindow: { start: 1, end: 1 } },
    ];
    for (const invalid of invalidReviews) {
      const result = resolveStablecoinPriceGapReviews([review.stablecoinId], review.reviewedAt, [invalid]);
      expect(result.activeById.size).toBe(0);
      expect(result.invalidGapReviewIds).toEqual([invalid.stablecoinId]);
    }
    const registry = resolveStablecoinPriceGapReviews(
      ACTIVE_STABLECOINS.map((asset) => asset.id), review.reviewedAt,
    );
    expect(registry.invalidGapReviewIds).toEqual([]);
    expect(registry.activeById.size).toBe(STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => !entry.weeklyUtcWindow).length);
  });

  it("drops accepted observation timestamps outside the JavaScript Date range", () => {
    const previousAcceptedAssetsById = new Map([[
      "missing",
      {
        id: "missing",
        symbol: "MISS",
        price: 0.998,
        priceSource: "pyth",
        priceObservedAt: 9_000_000_000_000_000,
      },
    ]]);

    const result = evaluateStablecoinActivePriceCoverage(
      [{ id: "missing", symbol: "MISS", price: null, priceObservedAt: 9_000_000_000_000_000 }],
      ["missing"],
      { previousAcceptedAssetsById },
    );

    expect(result.missingActiveAssets[0]).toMatchObject({
      currentObservedAt: null,
      lastAcceptedPrice: 0.998,
      lastAcceptedSource: "pyth",
      lastAcceptedObservedAt: null,
    });
  });

  it("loads verbose retained cap evidence and normalizes unknown source provenance to null", async () => {
    const nowSec = 1_790_000_000;
    const coverage = evaluateStablecoinActivePriceCoverage([], ["valid", "invalid"], { nowSec });
    const persistedCoverage = {
      ...coverage,
      missingActiveAssets: coverage.missingActiveAssets.map((detail, index) => ({
        ...detail, lastKnownMarketCapUsd: 32_686_926.18,
        lastKnownMarketCapObservedAt: nowSec - 900,
        lastKnownMarketCapSource: index === 0 ? "supply_history" : "invalid-source",
      })),
    };
    const db = mockD1([{
      match: "activePriceCoverage", rows: [],
      first: { started_at: nowSec, metadata: JSON.stringify({ activePriceCoverage: persistedCoverage }) },
    }]);
    const result = await loadPreviousStablecoinActivePriceCoverage(db, nowSec + 900);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected readable verbose continuity");
    expect(result.coverage.missingActiveAssets).toEqual([
      expect.objectContaining({
        stablecoinId: "valid", lastKnownMarketCapUsd: 32_686_926.18,
        lastKnownMarketCapObservedAt: nowSec - 900, lastKnownMarketCapSource: "supply_history",
      }),
      expect.objectContaining({
        stablecoinId: "invalid", lastKnownMarketCapUsd: 32_686_926.18,
        lastKnownMarketCapObservedAt: nowSec - 900, lastKnownMarketCapSource: null,
      }),
    ]);
  });

  it("loads bounded streak state from the latest prior cron metadata", async () => {
    const db = mockD1([{
      match: "activePriceCoverage",
      rows: [],
      first: {
        metadata: JSON.stringify({
          activePriceCoverage: {
            ...evaluateStablecoinActivePriceCoverage([{ id: "missing", price: null }], ["missing"]),
            missingActiveIds: ["missing"],
            missingActiveAssets: [],
            missingActiveState: [[
              "missing",
              3,
              1.001,
              "redstone",
              1_699_000_000,
              "no-accepted-price",
            ]],
          },
        }),
      },
    }]);

    await expect(loadPreviousStablecoinActivePriceCoverage(db, 1_700_000_000)).resolves.toMatchObject({
      status: "ok",
      coverage: {
        missingActiveIds: ["missing"],
        missingActiveAssets: [{
          stablecoinId: "missing",
          consecutiveMissingGenerations: 3,
          lastAcceptedPrice: 1.001,
          lastAcceptedSource: "redstone",
          alertEligible: true,
        }],
      },
    });
  });
});
