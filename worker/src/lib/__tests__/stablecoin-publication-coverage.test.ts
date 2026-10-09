import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  STABLECOIN_PRICE_GAP_REVIEWS,
  resolveStablecoinPriceGapReviews,
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

  it("becomes exact again as soon as a restored row is present", () => {
    expect(evaluateStablecoinPublicationCoverage(activeIds, nowSec).complete).toBe(true);
  });
});

describe("evaluateStablecoinActivePriceCoverage", () => {
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
    }], { requireMatch: true });
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
    await seedAbsentActivePriceCoverageMarketCaps(mockD1([], { requireMatch: true }), next, nowSec + 900);
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

  it.each(["wusd-worldwide", "tryb-bilira", "vcred-vcred"])("keeps %s missing while acknowledged, re-alerts at expiry, and clears on a real price", (id) => {
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

  it.each(["tryb-bilira", "vcred-vcred"])("renews %s with dated HTTPS evidence and a seven-day decision window", (id) => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
    const reviewedAt = Date.UTC(2026, 9, 7, 14, 18, 5) / 1000;
    expect(review.reviewedAt).toBe(reviewedAt);
    expect(review.reason).toContain("Reviewed 2026-10-07 UTC");
    expect(review.owner).toBe("ops");
    expect(review.sources.length).toBeGreaterThan(0);
    expect(review.sources.every((source) => /^https:\/\/\S+$/.test(source))).toBe(true);
    expect(review.expiresAt - review.reviewedAt).toBe(7 * 86_400);
    const resolved = resolveStablecoinPriceGapReviews([id], reviewedAt, [review]);
    expect(resolved.activeById.has(id)).toBe(true);
    expect(resolved.expiredGapReviewIds).toEqual([]);
    expect(resolved.invalidGapReviewIds).toEqual([]);
  });

  it.each(["audx-aussie-dollar-token", "brlv-crown"])("leaves recovered %s outside the acknowledgement registry", (id) => {
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
    const nowSec = Date.UTC(2026, 9, 7, 14, 18, 5) / 1000;
    let missing = evaluateStablecoinActivePriceCoverage(
      [{ id, price: null }], [id], { nowSec },
    );
    expect(missing.acknowledgedGapIds).toEqual([]);
    expect(missing.missingActiveAssets[0]).toMatchObject({
      alertEligible: false,
      acknowledgedGap: null,
      consecutiveMissingGenerations: 1,
    });
    expect(missing.alertEligibleIds).toEqual([]);
    for (let generation = 2; generation <= 3; generation++) {
      missing = evaluateStablecoinActivePriceCoverage(
        [{ id, price: null }], [id], { nowSec, previousCoverage: missing },
      );
    }
    expect(missing.missingActiveAssets[0]).toMatchObject({
      alertEligible: true,
      acknowledgedGap: null,
      consecutiveMissingGenerations: 3,
    });
    expect(missing.alertEligibleIds).toEqual([id]);
    const recovered = evaluateStablecoinActivePriceCoverage(
      [{ id, price: 0.7, priceSource: "coingecko", priceUpdatedAt: nowSec }],
      [id],
      { nowSec, previousCoverage: missing },
    );
    expect(recovered).toMatchObject({
      complete: true,
      pricedActiveIds: [id],
      missingActiveIds: [],
      acknowledgedGapIds: [],
      alertEligibleIds: [],
    });
  });

  it("acknowledges the recurring Mento weekend FX-closure gaps for CHFm and COPm", () => {
    const mentoReviews = STABLECOIN_PRICE_GAP_REVIEWS.filter(
      (entry) => entry.stablecoinId === "chfm-mento" || entry.stablecoinId === "copm-mento",
    );
    expect(mentoReviews).toHaveLength(2);
    for (const review of mentoReviews) {
      expect(review.owner).toBe("ops");
      expect(review.reason).toMatch(/weekend/i);
      expect(review.sources.length).toBeGreaterThanOrEqual(1);
      expect(review.sources.every((source) => /^https:\/\/\S+$/.test(source))).toBe(true);
      expect(review.expiresAt).toBeGreaterThan(review.reviewedAt);
      expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(30 * 86_400);
    }

    const ids = mentoReviews.map((review) => review.stablecoinId);
    const fridayClose = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } })),
      ids,
      { nowSec: Date.UTC(2026, 8, 25, 21, 30) / 1000, priceGapReviews: mentoReviews },
    );
    const saturday = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } })),
      ids,
      { nowSec: Date.UTC(2026, 9, 3, 12) / 1000, priceGapReviews: mentoReviews, previousCoverage: fridayClose },
    );
    expect(saturday).toMatchObject({
      missingPriceCount: 2,
      missingActiveIds: ids,
      alertEligibleIds: [],
      alertEligibleCount: 0,
      acknowledgedGapIds: ids,
      acknowledgedGapCount: 2,
    });
    expect(saturday.missingActiveAssets.every((asset) => asset.consecutiveMissingGenerations != null && asset.consecutiveMissingGenerations >= 2 && !asset.alertEligible)).toBe(true);

    const mondayReopen = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: 1.2 })),
      ids,
      { nowSec: Date.UTC(2026, 8, 28, 0, 15) / 1000, priceGapReviews: mentoReviews, previousCoverage: saturday },
    );
    expect(mondayReopen).toMatchObject({
      complete: true,
      pricedActiveIds: ids,
      missingPriceCount: 0,
      acknowledgedGapCount: 0,
    });
  });

  it("limits Mento acknowledgement to the reviewed weekly UTC closure", () => {
    const reviews = STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => ["chfm-mento", "copm-mento", "jpym-mento"].includes(entry.stablecoinId));
    const ids = reviews.map((review) => review.stablecoinId);
    for (const [nowSec, active] of [
      [Date.UTC(2026, 9, 2, 20, 59, 59) / 1000, false],
      [Date.UTC(2026, 9, 2, 21) / 1000, true],
      [Date.UTC(2026, 9, 4, 22, 59, 59) / 1000, true],
      [Date.UTC(2026, 9, 4, 23) / 1000, false],
      [Date.UTC(2026, 9, 5, 12) / 1000, false],
    ] as const) {
      expect([...resolveStablecoinPriceGapReviews(ids, nowSec, reviews).activeById.keys()]).toEqual(active ? ids : []);
    }
    const assets = ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } }));
    const closed = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec: Date.UTC(2026, 9, 4, 22) / 1000, priceGapReviews: reviews });
    const reopened = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec: Date.UTC(2026, 9, 4, 23) / 1000, priceGapReviews: reviews, previousCoverage: closed });
    expect(reopened.acknowledgedGapIds).toEqual([]);
    expect(reopened.alertEligibleIds).toEqual(ids);
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
    }], { requireMatch: true });

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
