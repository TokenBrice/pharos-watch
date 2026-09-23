import { describe, expect, it } from "vitest";
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
} from "../stablecoin-publication-coverage";
import { mockD1 } from "@shared/test-utils/mock-d1";

const QUARANTINED_NIGHT_WATCH_OMISSIONS = [
  "benji-franklin-templeton",
  "wtgxx-wisdomtree",
  "busd0-usual",
  "tbill-openeden",
  "cetes-etherfuse",
  "jusd-jusd-stable-token",
  "vndc-jade-labs",
  "sofid-sofi",
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

    expect(coverage).toEqual({
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

  it("keeps acknowledged long gaps missing, re-alerts at expiry, and ignores reviews for priced assets", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
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
    expect(registry.activeById.size).toBe(STABLECOIN_PRICE_GAP_REVIEWS.length);
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
      missingActiveIds: ["missing"],
      missingActiveAssets: [{
        stablecoinId: "missing",
        consecutiveMissingGenerations: 3,
        lastAcceptedPrice: 1.001,
        lastAcceptedSource: "redstone",
        alertEligible: true,
      }],
    });
  });
});
