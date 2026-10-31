import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
  STABLECOIN_PUBLICATION_WAIVERS,
  STABLECOIN_PRICE_GAP_REVIEWS,
  STABLECOIN_MARKET_HOURS_CALENDARS,
  resolveStablecoinScheduledPriceClosures,
  resolveStablecoinMarketHours,
  resolveMentoFxMarketReopen,
  resolveStablecoinPriceGapReviews,
  classifyStablecoinPublicationGap,
  compactStablecoinActivePriceCoverage,
  parseMissingActivePriceDetail,
  parsePersistedMissingActivePriceState,
  evaluateStablecoinActivePriceCoverage,
  evaluateStablecoinPublicationCoverage,
  loadPreviousStablecoinActivePriceCoverage,
  seedAbsentActivePriceCoverageMarketCaps,
} from "../stablecoin-publication-coverage";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mentoFpmmProvider } from "../authoritative-price-sources/mento-fpmm";
import { mentoBrokerProvider } from "../authoritative-price-sources/mento-broker";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC } from "@shared/lib/status-thresholds";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const QUARANTINED_NIGHT_WATCH_OMISSIONS = [
  "benji-franklin-templeton",
  "wtgxx-wisdomtree",
  "tbill-openeden",
  "cetes-etherfuse",
  "jusd-jusd-stable-token",
  "vndc-jade-labs",
  // sofid-sofi left this list on 2026-09-29: CoinGecko market cap and the
  // DefiLlama 430 row restored a positive supply path, so it is active again.
  // busd0-usual left this list on 2026-10-30: CoinGecko usd0-liquid-bond
  // restored a positive price and market cap, so it is active again.
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
  it.each([null, 0.98662])("clears HBD missing-price coverage only after an observed native price is published: %s", (price) => {
    const result = evaluateStablecoinActivePriceCoverage([{
      id: "hbd-hive", price, priceSource: "hive-native-cg", priceObservedAt: 1_792_391_396,
      priceObservedAtMode: "local_fetch", circulating: { peggedUSD: 32_000_000 },
    }], ["hbd-hive"], { nowSec: 1_792_391_400, priceGapReviews: STABLECOIN_PRICE_GAP_REVIEWS });
    expect(result.missingPriceCount).toBe(price == null ? 1 : 0);
    expect(result.pricedActiveCount).toBe(price == null ? 0 : 1);
  });
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
  it.each(["usdk-kast", "usdn-noble"])(
    "counts %s's published M0 redemption par as a nominal reference, never as observed or missing",
    (id) => {
      const coverage = evaluateStablecoinActivePriceCoverage([{
        id,
        price: 1,
        priceSource: "protocol-par",
        priceObservedAtMode: "nominal_reference" as const,
        nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" as const },
        circulating: { peggedUSD: 24_000_000 },
      }], [id], { priceGapReviews: [] });

      expect(coverage).toMatchObject({
        complete: true,
        pricedActiveCount: 0,
        pricedActiveIds: [],
        missingPriceCount: 0,
        missingActiveIds: [],
        nominalReferenceCount: 1,
        nominalReferenceIds: [id],
        nominalReferenceMarketCapUsd: 24_000_000,
        nominalReferenceReason: "reviewed-nominal-reference",
      });
    },
  );
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

  it.each(["wusd-worldwide", "pht-pht"])("keeps %s missing while acknowledged, re-alerts at expiry, and clears on a real price", (id) => {
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


  it("bounds the October 28 USDFC continuing-gap review without dropping the asset at expiry", () => {
    const id = "usdfc-secured-finance";
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
    const reviewedAt = Date.UTC(2026, 9, 28, 9, 52) / 1000;
    const expiresAt = Date.UTC(2026, 10, 4, 9, 52) / 1000;
    expect(review).toMatchObject({ owner: "ops", reviewedAt, expiresAt });
    expect(expiresAt - reviewedAt).toBe(7 * 86_400);
    expect(review.reason).toContain("2026-10-28 09:51");
    expect(review.reason).toContain("2026-10-14 18:27:04 UTC");
    expect(review.reason).toContain("missing-quote");
    expect(review.sources.some((source) => source.includes("/onchain/networks/filecoin/tokens/multi/"))).toBe(true);
    const assets = [{ id, price: null, circulating: { peggedUSD: 184_320.6279474966 } }];
    const coverage = evaluateStablecoinActivePriceCoverage(assets, [id], {
      nowSec: Date.UTC(2026, 9, 30, 6, 36) / 1000, priceGapReviews: [review],
    });
    expect(coverage).toMatchObject({
      complete: false, missingActiveIds: [id], pricedActiveIds: [],
      acknowledgedGapIds: [id], alertEligibleIds: [], expiredGapReviewIds: [],
    });
    const compact = compactStablecoinActivePriceCoverage(coverage, 0);
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: expiresAt - 1 }))
      .toMatchObject({ acknowledgedGap: { reviewedAt, expiresAt }, alertEligible: false });
    const expired = evaluateStablecoinActivePriceCoverage(assets, [id], {
      nowSec: expiresAt, priceGapReviews: [review], previousCoverage: coverage,
    });
    expect(expired).toMatchObject({
      missingActiveIds: [id], pricedActiveIds: [], acknowledgedGapIds: [],
      alertEligibleIds: [id], expiredGapReviewIds: [id],
    });
    expect(evaluateStablecoinPublicationCoverage([id], expiresAt, STABLECOIN_PUBLICATION_WAIVERS, [id]))
      .toMatchObject({ complete: true, presentActiveCount: 1, waivedActiveIds: [] });
    expect(assets[0]!.price).toBeNull();
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

  it("excludes frozen bnUSD from the active census and drops its retired gap review", () => {
    const id = "bnusd-balanced";
    const activeIds = ACTIVE_STABLECOINS.map((coin) => coin.id);
    expect(activeIds).not.toContain(id);
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
    const coverage = evaluateStablecoinActivePriceCoverage([
      ...activeIds.map((activeId) => ({ id: activeId, price: 1 })),
      { id, price: null, circulating: { peggedUSD: 50_000_000 } },
    ], activeIds, { nowSec: Date.UTC(2026, 9, 29, 12) / 1000 });
    expect(coverage).toMatchObject({ complete: true, missingPriceCount: 0 });
    expect(coverage.pricedActiveIds).not.toContain(id);
    expect(coverage.missingActiveIds).not.toContain(id);
    expect(coverage.invalidGapReviewIds).not.toContain(id);
    expect(coverage.expiredGapReviewIds).not.toContain(id);
  });


  it.each([
    ["2026-10-30T20:59:00Z", false],
    ["2026-10-30T21:00:00Z", true],
    ["2026-10-31T12:00:00Z", true],
    ["2026-11-01T22:59:00Z", true],
    ["2026-11-01T23:00:00Z", false],
    ["2026-11-02T12:00:00Z", false],
    ["2026-12-24T21:59:59Z", false],
    ["2026-12-24T22:00:00Z", true],
    ["2026-12-25T00:00:00Z", true],
    ["2026-12-25T23:59:59Z", true],
    ["2026-12-31T21:59:59Z", false],
    ["2026-12-31T22:00:00Z", true],
    ["2027-01-01T00:00:00Z", true],
    ["2027-01-01T23:59:59Z", true],
    // Holiday reopening does not override the weekly closure.
    ["2027-01-02T00:00:00Z", true],
    ["2027-01-03T23:00:00Z", false],
    ["2027-12-26T23:00:00Z", false],
  ] as const)("classifies Mento UTC market hours at %s (closed=%s)", (date, closed) => {
    const ids = STABLECOIN_MARKET_HOURS_CALENDARS[0].assets.map((asset) => asset.stablecoinId);
    const nowSec = Date.parse(date) / 1000;
    const assets = ids.map((id) => ({ id, price: null, circulating: { peggedUSD: 100 } }));
    const first = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec, priceGapReviews: [] });
    const result = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec, priceGapReviews: [], previousCoverage: first });
    expect(result).toMatchObject({
      complete: false, pricedActiveCount: 0, missingPriceCount: ids.length, missingActiveIds: ids,
      acknowledgedGapIds: [], acknowledgedGapCount: 0,
      scheduledClosureGapIds: closed ? ids : [],
      alertEligibleIds: closed || date === "2026-11-01T23:00:00Z" || date === "2027-01-03T23:00:00Z" ? [] : ids,
      expiredGapReviewIds: [], invalidGapReviewIds: [], affectedMarketCapUsd: 500,
    });
    for (const gap of result.missingActiveAssets) {
      expect(gap).toMatchObject({ currentPrice: null, consecutiveMissingGenerations: 2, acknowledgedGap: null });
      expect(gap.scheduledClosure).toEqual(closed ? expect.objectContaining({ reason: "market-closed", owner: "ops" }) : null);
    }
    expect(assets.every((asset) => asset.price === null)).toBe(true);
  });

  it.each([
    ["2026-10-30T20:59:00Z", null],
    ["2026-10-30T21:00:00Z", "2026-11-01T23:00:00Z"],
    ["2026-10-31T12:00:00Z", "2026-11-01T23:00:00Z"],
    ["2026-11-01T22:59:00Z", "2026-11-01T23:00:00Z"],
    ["2026-11-01T23:00:00Z", null],
    ["2026-12-24T22:00:00Z", "2026-12-27T23:00:00Z"],
    ["2027-01-01T12:00:00Z", "2027-01-03T23:00:00Z"],
    ["2027-01-02T00:00:00Z", "2027-01-03T23:00:00Z"],
  ] as const)("resolves the scheduled Mento FX reopen from %s to %s", (date, expected) => {
    const reopen = resolveMentoFxMarketReopen(Date.parse(date) / 1_000);
    expect(reopen).toBe(expected === null ? null : Date.parse(expected) / 1_000);
  });

  it.each(["2025-12-26T00:00:00Z", "2026-01-02T00:00:00Z"])("ends a holiday closure on the open weekday %s", (date) => {
    const nowSec = Date.parse(date) / 1000;
    const calendar = { ...STABLECOIN_MARKET_HOURS_CALENDARS[0], reviewedAt: Date.UTC(2025, 0, 1) / 1000 };
    const ids = calendar.assets.map((asset) => asset.stablecoinId);
    expect(resolveStablecoinScheduledPriceClosures(ids, nowSec - 1, [calendar]).size).toBe(ids.length);
    expect(resolveStablecoinScheduledPriceClosures(ids, nowSec, [calendar]).size).toBe(0);
    expect(resolveStablecoinMarketHours(ids, nowSec, [calendar]).alertSuppressedIds.size).toBe(ids.length);
    const gateSec = ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS * CRON_INTERVALS["sync-stablecoins"];
    expect(resolveStablecoinMarketHours(ids, nowSec + gateSec, [calendar]).alertSuppressedIds.size).toBe(0);
  });

  it("retains raw closure streaks while requiring the normal open-market cadence gate after reopen", () => {
    const id = "chfm-mento";
    const ids = [id];
    const assets = [{ id, price: null, circulating: { peggedUSD: 100 } }];
    const reopen = Date.UTC(2026, 10, 1, 23) / 1000;
    const first = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec: reopen - 3600, priceGapReviews: [] });
    const previous = { ...first, missingActiveAssets: [{ ...first.missingActiveAssets[0], consecutiveMissingGenerations: 800 }] };
    const interval = CRON_INTERVALS["sync-stablecoins"];
    for (const [elapsed, eligible] of [[0, false], [interval, false], [2 * interval - 1, false], [2 * interval, true]] as const) {
      const result = evaluateStablecoinActivePriceCoverage(assets, ids, {
        nowSec: reopen + elapsed, priceGapReviews: [], previousCoverage: previous,
      });
      expect(result).toMatchObject({ missingActiveIds: ids, affectedMarketCapUsd: 100,
        alertEligibleIds: eligible ? ids : [], scheduledClosureGapIds: [], acknowledgedGapIds: [] });
      expect(result.missingActiveAssets[0]).toMatchObject({ consecutiveMissingGenerations: 801, alertEligible: eligible });
      expect(parseMissingActivePriceDetail(result.missingActiveAssets[0], { nowSec: reopen + elapsed })?.alertEligible).toBe(eligible);
    }
    const weekday = Date.UTC(2026, 10, 2, 12) / 1000;
    const fresh = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec: weekday, priceGapReviews: [] });
    expect(fresh.alertEligibleIds).toEqual([]);
    expect(evaluateStablecoinActivePriceCoverage(assets, ids, {
      nowSec: weekday + interval, priceGapReviews: [], previousCoverage: fresh,
    }).alertEligibleIds).toEqual(ids);
  });

  it("keeps the reviewed calendar identities and lanes exact and never classifies priced assets as gaps", () => {
    const calendar = STABLECOIN_MARKET_HOURS_CALENDARS[0];
    const configuredRoutes = ACTIVE_STABLECOINS.flatMap((asset) => [mentoBrokerProvider, mentoFpmmProvider]
      .filter((provider) => provider.matches(asset.id))
      .map((provider) => ({ stablecoinId: asset.id, lane: provider.source })));
    const sorted = <T extends { stablecoinId: string }>(assets: readonly T[]) =>
      [...assets].sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
    expect(sorted(calendar.assets)).toEqual(sorted(configuredRoutes));
    expect(calendar.sources).toHaveLength(5);
    expect(calendar.sources.every((source) => source.includes("/blob/4048a6c392790527d7ab3133af6f3336efc0cc97/"))).toBe(true);
    const ids: string[] = calendar.assets.map((asset) => asset.stablecoinId);
    expect(ids.every((id) => ACTIVE_STABLECOINS.some((asset) => asset.id === id))).toBe(true);
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => ids.includes(review.stablecoinId))).toBe(false);
    const result = evaluateStablecoinActivePriceCoverage(ids.map((id) => ({ id, price: 1.2 })), ids, {
      nowSec: Date.UTC(2026, 9, 31, 12) / 1000,
    });
    expect(result).toMatchObject({ complete: true, pricedActiveIds: ids, missingActiveIds: [],
      scheduledClosureGapIds: [], acknowledgedGapIds: [], alertEligibleIds: [], missingActiveAssets: [] });
  });

  it("fails closed on an invalid, future or expired calendar review", () => {
    const calendar = STABLECOIN_MARKET_HOURS_CALENDARS[0];
    const nowSec = Date.UTC(2026, 9, 31, 12) / 1000;
    const ids: string[] = calendar.assets.map((asset) => asset.stablecoinId);
    for (const invalid of [
      { ...calendar, owner: "" }, { ...calendar, reviewReason: " " },
      { ...calendar, sources: [] }, { ...calendar, sources: ["http://example.com"] },
      { ...calendar, reviewedAt: nowSec + 1 }, { ...calendar, reviewedAt: Number.NaN },
      { ...calendar, reviewDeadline: nowSec }, { ...calendar, reviewDeadline: calendar.reviewedAt },
    ]) {
      const result = resolveStablecoinMarketHours(ids, nowSec, [invalid]);
      expect(result.closedById.size).toBe(0);
      expect([...result.expiredCalendarIds, ...result.invalidCalendarIds]).toEqual([calendar.calendarId]);
    }
    expect(resolveStablecoinScheduledPriceClosures(["usdc-circle"], nowSec).size).toBe(0);
    expect(resolveStablecoinScheduledPriceClosures(ids, Number.NaN).size).toBe(0);
    const deadline = Date.UTC(2027, 9, 29, 22) / 1000;
    const reviewed = { ...calendar, reviewDeadline: deadline };
    expect(resolveStablecoinScheduledPriceClosures(ids, deadline - 1, [reviewed]).size).toBe(ids.length);
    const expired = resolveStablecoinMarketHours(ids, deadline, [reviewed]);
    expect(expired.closedById.size).toBe(0);
    expect(expired.alertSuppressedIds.size).toBe(0);
    expect(expired.expiredCalendarIds).toEqual([calendar.calendarId]);
  });

  it("retires the recovered TRYB review while acknowledging active PHT", () => {
    const ids = ["tryb-bilira", "pht-pht"];
    const reviews = STABLECOIN_PRICE_GAP_REVIEWS.filter((entry) => ids.includes(entry.stablecoinId));
    expect(reviews.map((review) => review.stablecoinId).sort()).toEqual(["pht-pht"]);
    const nowSec = Date.UTC(2026, 9, 29, 12) / 1000;
    const coverage = evaluateStablecoinActivePriceCoverage(
      ids.map((id) => ({ id, price: id === "tryb-bilira" ? 0.0203935242416747 : null })),
      ids,
      { nowSec, priceGapReviews: reviews },
    );
    expect(coverage).toMatchObject({
      pricedActiveIds: ["tryb-bilira"],
      missingActiveIds: ["pht-pht"],
      acknowledgedGapIds: ["pht-pht"],
      expiredGapReviewIds: [],
      invalidGapReviewIds: [],
      alertEligibleIds: [],
    });
    for (const review of reviews) {
      expect(review.reviewedAt).toBeLessThanOrEqual(nowSec);
      expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(14 * 86_400);
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

  it("retires the STBT gap review after the reviewed Curve exact-pool lane admits the market", () => {
    const id = "stbt-matrixdock";
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
    const nowSec = Date.UTC(2026, 9, 31, 13) / 1000;
    const resolved = resolveStablecoinPriceGapReviews([id], nowSec);
    expect(resolved.activeById.size).toBe(0);
    expect(resolved.expiredGapReviewIds).not.toContain(id);
    expect(resolved.invalidGapReviewIds).not.toContain(id);
    const coverage = evaluateStablecoinActivePriceCoverage(
      [{ id, price: 0.9945 }],
      [id],
      { nowSec, priceGapReviews: [] },
    );
    expect(coverage).toMatchObject({
      complete: true,
      pricedActiveIds: [id],
      missingActiveIds: [],
      acknowledgedGapIds: [],
      alertEligibleIds: [],
    });
  });

  it("renews the October 29 WUSD source review as a 30-day owner decision without retiring the lifecycle question", () => {
    const id = "wusd-worldwide";
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
    expect(review).toMatchObject({ owner: "ops", reviewedAt: Date.UTC(2026, 9, 29, 11) / 1000 });
    expect(review.expiresAt).toBe(Date.UTC(2026, 10, 27, 11) / 1000);
    expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(30 * 86_400);
    expect(review.reason).toContain("2026-10-29 11:00 UTC");
    expect(review.reason).toContain("2026-08-21 22:51:40 UTC");
    expect(review.reason).toContain("$1.17");
    expect(review.reason).toContain("zero tickers");
    expect(review.reason).toContain("$1,135.07");
    expect(review.reason).toContain("$50K per-pool floor");
    expect(review.reason).toContain("NXDOMAIN");
    expect(review.reason).toContain("Owner decision 2026-10-29: keep active pending a primary discontinuation source; freeze if one appears");
    expect(review.reason).toContain("Keep the price missing; all admission gates preserved");
    expect(review.reason).toContain("lifecycle/redemption-route decision stays open");
    expect(review.sources).toContain("https://dns.google/resolve?name=wallet.wspn.io&type=A");
    expect(review.sources.some((source) => source.includes("support.coins.ph"))).toBe(true);
    expect(review.sources).toContain("https://wspn.io/solutions/");
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === id)!;
    expect(coin.contracts).toHaveLength(3);
    const coverage = evaluateStablecoinActivePriceCoverage([{ id, price: null }], [id], {
      nowSec: review.reviewedAt, priceGapReviews: [review],
    });
    expect(coverage).toMatchObject({
      missingActiveIds: [id], acknowledgedGapIds: [id], pricedActiveIds: [],
      invalidGapReviewIds: [], expiredGapReviewIds: [], alertEligibleIds: [],
    });
  });

  it("retires the recovered IDRT review and the expired M0-family reviews that would acknowledge nothing", () => {
    for (const id of ["idrt-rupiah-token", "usdk-kast"]) {
      expect(ACTIVE_STABLECOINS.some((coin) => coin.id === id)).toBe(true);
      expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
      const first = evaluateStablecoinActivePriceCoverage(
        [{ id, price: null, circulating: { peggedUSD: 100 } }], [id], { nowSec: Date.UTC(2026, 9, 29, 12) / 1000 },
      );
      const second = evaluateStablecoinActivePriceCoverage(
        [{ id, price: null, circulating: { peggedUSD: 100 } }], [id],
        { nowSec: Date.UTC(2026, 9, 29, 12) / 1000 + 900, previousCoverage: first },
      );
      expect(second).toMatchObject({ missingActiveIds: [id], acknowledgedGapIds: [], alertEligibleIds: [id] });
      expect([...second.expiredGapReviewIds, ...second.invalidGapReviewIds]).not.toContain(id);
    }
    // IDRT recovered through its ordinary lane: a published price stays priced, never acknowledged.
    const idrt = evaluateStablecoinActivePriceCoverage(
      [{ id: "idrt-rupiah-token", price: 0.00005568, priceSource: "coingecko" }], ["idrt-rupiah-token"],
      { nowSec: Date.UTC(2026, 9, 29, 12) / 1000 },
    );
    expect(idrt).toMatchObject({ complete: true, pricedActiveIds: ["idrt-rupiah-token"], missingPriceCount: 0 });
  });

  it("corrects PHT's short evidence review and names the open holder-exit decision at its expiry", () => {
    const id = "pht-pht";
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === id)!;
    expect(coin).toBeDefined();
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === id)!;
    expect(review).toMatchObject({
      owner: "ops",
      reviewedAt: Date.UTC(2026, 9, 29, 11, 1) / 1000,
      expiresAt: Date.UTC(2026, 10, 10, 11, 1) / 1000,
    });
    expect(review.expiresAt - review.reviewedAt).toBeLessThanOrEqual(14 * 86_400);
    expect(review.reason).toContain("2026-10-29 11:01 UTC");
    expect(review.reason).toContain("2026-08-14 17:36:40 UTC");
    expect(review.reason).toContain("$45,272.89");
    expect(review.reason).toContain("$50K per-pool liquidity floor");
    expect(review.reason).toContain("HTTP 404");
    expect(review.reason).toContain("Open holder-exit question");
    expect(review.reason).toContain("2026-11-10 11:01 UTC");
    expect(review.sources).toContain("https://docs.apacx.io/user-guides/pht-onramp-and-offramp.md");
    expect(coin.contracts).toHaveLength(3);
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
    // Every authored row is valid at the latest review clock; expiry is
    // exercised separately, so rows may already be expired here.
    const latestReviewedAt = Math.max(...STABLECOIN_PRICE_GAP_REVIEWS.map((entry) => entry.reviewedAt));
    const registry = resolveStablecoinPriceGapReviews(
      ACTIVE_STABLECOINS.map((asset) => asset.id), latestReviewedAt,
    );
    expect(registry.invalidGapReviewIds).toEqual([]);
    expect(registry.activeById.size + registry.expiredGapReviewIds.length)
      .toBeLessThanOrEqual(STABLECOIN_PRICE_GAP_REVIEWS.length);
    for (const id of registry.activeById.keys()) expect(registry.expiredGapReviewIds).not.toContain(id);
  });

  it("rejects a review dated after the evaluation clock as invalid evidence", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
    const resolveAt = (nowSec: number, candidate = review) => resolveStablecoinPriceGapReviews([candidate.stablecoinId], nowSec, [candidate]);
    expect(resolveAt(review.reviewedAt - 1)).toMatchObject({ invalidGapReviewIds: [review.stablecoinId], expiredGapReviewIds: [] });
    expect(resolveAt(review.reviewedAt - 1).activeById.size).toBe(0);
    expect([...resolveAt(review.reviewedAt).activeById.keys()]).toEqual([review.stablecoinId]);
    expect([...resolveAt(review.expiresAt - 1).activeById.keys()]).toEqual([review.stablecoinId]);
    expect(resolveAt(review.expiresAt)).toMatchObject({ invalidGapReviewIds: [], expiredGapReviewIds: [review.stablecoinId] });

    // Coverage keeps the gap missing, unacknowledged and counted; streaks still advance.
    const ids = [review.stablecoinId];
    const assets = [{ id: review.stablecoinId, price: null, circulating: { peggedUSD: 100 } }];
    const first = evaluateStablecoinActivePriceCoverage(assets, ids, { nowSec: review.reviewedAt - 900, priceGapReviews: [review] });
    const coverage = evaluateStablecoinActivePriceCoverage(assets, ids, {
      nowSec: review.reviewedAt - 1, priceGapReviews: [review], previousCoverage: first,
    });
    expect(coverage).toMatchObject({
      missingPriceCount: 1, missingActiveIds: ids, acknowledgedGapIds: [], acknowledgedGapCount: 0,
      alertEligibleIds: ids, invalidGapReviewIds: ids, expiredGapReviewIds: [],
    });
    expect(coverage.missingActiveAssets[0]).toMatchObject({ currentPrice: null, consecutiveMissingGenerations: 2, acknowledgedGap: null });

    // Registry readback (compact and verbose) applies the same clock.
    const compact = compactStablecoinActivePriceCoverage(coverage, 0);
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.reviewedAt - 1 }))
      .toMatchObject({ acknowledgedGap: null, alertEligible: true });
    expect(parsePersistedMissingActivePriceState(compact.missingActiveState[0], { nowSec: review.reviewedAt }))
      .toMatchObject({ acknowledgedGap: { owner: "ops", expiresAt: review.expiresAt }, alertEligible: false });
    expect(parseMissingActivePriceDetail(coverage.missingActiveAssets[0], { nowSec: review.reviewedAt - 1 }))
      .toMatchObject({ acknowledgedGap: null });
    expect(parseMissingActivePriceDetail(coverage.missingActiveAssets[0], { nowSec: review.reviewedAt }))
      .toMatchObject({ acknowledgedGap: { expiresAt: review.expiresAt } });
  });

  it("keeps absent HBD missing and alert-eligible without an authored review despite its last native acceptance", () => {
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === "hbd-hive")).toBe(false);
    const id = "hbd-hive";
    const nowSec = Date.UTC(2026, 9, 26, 20) / 1000;
    const accepted = evaluateStablecoinActivePriceCoverage([{
      id, price: 0.99759, priceSource: "hive-native-cg", priceObservedAt: Date.UTC(2026, 9, 24, 14, 15, 43) / 1000,
      priceObservedAtMode: "local_fetch", circulating: { peggedUSD: 32_000_000 },
    }], [id], { nowSec: Date.UTC(2026, 9, 24, 14, 16) / 1000 });
    expect(accepted.pricedActiveIds).toEqual([id]);
    const first = evaluateStablecoinActivePriceCoverage([], [id], { nowSec: nowSec - 900, previousCoverage: accepted });
    const absent = evaluateStablecoinActivePriceCoverage([], [id], { nowSec, previousCoverage: first });
    expect(absent).toMatchObject({
      missingActiveIds: [id], missingPriceCount: 1, acknowledgedGapIds: [], alertEligibleIds: [id],
    });
    expect([...absent.expiredGapReviewIds, ...absent.invalidGapReviewIds]).not.toContain(id);
    expect(absent.missingActiveAssets[0]).toMatchObject({
      currentPrice: null, marketCapUsd: null, acknowledgedGap: null, alertEligible: true,
    });
  });

  it.each([
    ["usda-avalon", 0.9998, "defillama-contract"],
    ["usdn-smardex", 0.991, "coinmarketcap"],
  ] as const)("retires the recovered %s review: the next gap is unacknowledged and an observed price stays priced", (id, price, priceSource) => {
    expect(STABLECOIN_PRICE_GAP_REVIEWS.some((review) => review.stablecoinId === id)).toBe(false);
    const nowSec = Date.UTC(2026, 9, 27, 12) / 1000;
    const priced = evaluateStablecoinActivePriceCoverage([{ id, price, priceSource, priceObservedAt: nowSec - 60 }], [id], { nowSec });
    expect(priced).toMatchObject({ complete: true, pricedActiveIds: [id], missingPriceCount: 0 });
    const firstGap = evaluateStablecoinActivePriceCoverage([{ id, price: null }], [id], { nowSec: nowSec + 900, previousCoverage: priced });
    const secondGap = evaluateStablecoinActivePriceCoverage([{ id, price: null }], [id], { nowSec: nowSec + 1800, previousCoverage: firstGap });
    expect(secondGap).toMatchObject({
      missingActiveIds: [id], acknowledgedGapIds: [], alertEligibleIds: [id],
    });
    expect([...secondGap.expiredGapReviewIds, ...secondGap.invalidGapReviewIds]).not.toContain(id);
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

  it("decodes complete object/tuple details equally across legacy slots, malformed provenance and review expiry", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === review.stablecoinId)!;
    const tuples: unknown[][] = [
      [coin.id, 2, 0.99, "unknown-source", review.reviewedAt, "no-accepted-price"],
      [coin.id, null, -1, {}, 9e15, 0, "previous-coverage-read-failed", 100, review.reviewedAt, "unknown-source", 0],
      [coin.id, 0, "1", " ", null, " ", "unknown-reason", null, null, {}, null],
      [coin.id, 1.5, NaN, null, Infinity, {}, null, NaN, Infinity, "publication", Infinity],
      [coin.id, 3, 1, "coingecko", review.reviewedAt, "active-row-missing", null, 100, review.reviewedAt, "supply_history", null],
    ];
    for (const tuple of tuples) {
      const verbose = {
        stablecoinId: tuple[0], symbol: coin.symbol, currentPrice: null,
        consecutiveMissingGenerations: tuple[1], lastAcceptedPrice: tuple[2], lastAcceptedSource: tuple[3],
        lastAcceptedObservedAt: tuple[4], rejectionReason: tuple[5], streakUnavailableReason: tuple[6],
        lastKnownMarketCapUsd: tuple[7], lastKnownMarketCapObservedAt: tuple[8],
        lastKnownMarketCapSource: tuple[9], marketCapUsd: tuple[10],
        acknowledgedGap: { owner: "persisted-not-trusted" }, alertEligible: false,
      };
      for (const nowSec of [review.expiresAt - 1, review.expiresAt]) {
        const detail = parsePersistedMissingActivePriceState(tuple, { nowSec });
        expect(detail).toEqual(parseMissingActivePriceDetail(verbose, { nowSec }));
        expect(detail?.acknowledgedGap != null).toBe(nowSec < review.expiresAt);
        expect(detail?.currentPrice).toBeNull();
      }
    }
    expect(parsePersistedMissingActivePriceState(tuples[0], { nowSec: review.expiresAt })?.lastAcceptedSource)
      .toBe("unknown-source");
    expect(parsePersistedMissingActivePriceState(tuples[1], { nowSec: review.expiresAt })).toMatchObject({
      consecutiveMissingGenerations: null, streakUnavailableReason: "previous-coverage-read-failed",
      lastAcceptedSource: null, lastKnownMarketCapSource: null, alertEligible: true,
    });
    expect(parsePersistedMissingActivePriceState(tuples[2], { nowSec: review.expiresAt })).toMatchObject({
      consecutiveMissingGenerations: null, streakUnavailableReason: "previous-coverage-malformed",
      lastAcceptedPrice: null, rejectionReason: "no-accepted-price", lastKnownMarketCapSource: null,
    });
    expect(parseMissingActivePriceDetail({ stablecoinId: coin.id, currentPrice: 1 }, { nowSec: review.expiresAt - 1 }))
      .toMatchObject({ acknowledgedGap: null });
  });

  it("retains the compact entry shape guard", () => {
    for (const value of [null, {}, [], ["id", 1], [7, 1, null, null, null, null]]) {
      expect(parsePersistedMissingActivePriceState(value)).toBeNull();
    }
  });

  it.each([false, true])("requires every exact missing ID while resolving duplicate details (verbose=%s)", async (verbose) => {
    const nowSec = 1_790_000_000;
    const coverage = evaluateStablecoinActivePriceCoverage([], ["missing"], { nowSec });
    const detail = { ...coverage.missingActiveAssets[0], consecutiveMissingGenerations: 5 };
    const state = {
      ...coverage, missingActiveAssets: verbose ? [detail, { ...detail, consecutiveMissingGenerations: 6 }] : [],
      missingActiveState: [["missing", 2, null, null, null, "no-accepted-price"],
        ["missing", 3, null, null, null, "no-accepted-price"]],
    };
    const read = (missingActiveIds: string[]) => loadPreviousStablecoinActivePriceCoverage(mockD1([{
      match: "activePriceCoverage", rows: [],
      first: { metadata: JSON.stringify({ activePriceCoverage: { ...state, missingActiveIds } }) },
    }]), nowSec);
    const result = await read(["missing"]);
    expect(result).toMatchObject({ status: "ok", coverage: {
      missingActiveIds: ["missing"], missingActiveAssets: [{ consecutiveMissingGenerations: verbose ? 6 : 3 }],
    } });
    expect(await read(["missing", "no-detail"])).toEqual({ status: "read-error", reason: "previous-coverage-malformed" });
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
