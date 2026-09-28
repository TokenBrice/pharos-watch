import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  loadStablecoinCoverageHealth,
  loadStablecoinPublicationHealth,
  unknownActivePriceCoverageHealth,
  unknownStablecoinPublicationHealth,
} from "../stablecoin-publication-health";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { STABLECOIN_PRICE_GAP_REVIEWS } from "../stablecoin-publication-coverage";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

const activeIds = [...ACTIVE_IDS];

function publicationCoverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    complete: true,
    expectedActiveCount: activeIds.length,
    presentActiveCount: activeIds.length,
    waivedActiveCount: 0,
    missingActiveIds: [],
    waivedActiveIds: [],
    expiredWaiverIds: [],
    ...overrides,
  };
}

function priceCoverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    complete: true,
    expectedActiveCount: activeIds.length,
    presentActiveCount: activeIds.length,
    pricedActiveCount: activeIds.length,
    pricedActiveIds: activeIds,
    missingPriceCount: 0,
    missingActiveIds: [],
    affectedMarketCapUsd: 0,
    missingActiveAssets: [],
    alertEligibleCount: 0,
    alertEligibleIds: [],
    maxConsecutiveMissingGenerations: 0,
    ...overrides,
  };
}

function insertRun(sqlite: DatabaseSync, job: string, startedAt: number, metadata: unknown): void {
  sqlite
    .prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES (?, ?, 0, 'ok', ?)")
    .run(job, startedAt, typeof metadata === "string" || metadata === null ? metadata : JSON.stringify(metadata));
}

describe("stablecoin publication health", () => {
  it("selects exact publication evidence over wrappers, other jobs, partial evidence and timestamp ties", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    insertRun(sqlite, "sync-stablecoins", 200, {
      activePublicationCoverage: publicationCoverage({ complete: false }),
      activePriceCoverage: priceCoverage(),
    });
    insertRun(sqlite, "sync-stablecoins", 200, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    insertRun(sqlite, "sync-stablecoins", 300, { childDisposition: "abandoned" });
    insertRun(sqlite, "other-job", 400, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    insertRun(sqlite, "sync-stablecoins", 500, { activePublicationCoverage: publicationCoverage() });
    insertRun(sqlite, "sync-stablecoins", 600, { activePriceCoverage: priceCoverage() });
    // Later rows that carry no evidence at all must never outrank the exact row.
    insertRun(sqlite, "sync-stablecoins", 700, null);
    insertRun(sqlite, "sync-stablecoins", 800, {});
    insertRun(sqlite, "sync-stablecoins", 900, "not json at all");

    const result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toMatchObject({ status: "complete", observedAt: 200 });
    expect(result.activePriceCoverage).toMatchObject({ status: "complete", observedAt: 200 });
  });

  it("reports unknown health when no run carries publication or price evidence", async () => {
    const { db } = fixtures.open();
    const result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toEqual(unknownStablecoinPublicationHealth(null));
    expect(result.activePriceCoverage).toEqual(unknownActivePriceCoverageHealth(null));
  });

  it("exposes unknown factories with an explicit observation time and no claimed coverage", () => {
    expect(unknownStablecoinPublicationHealth(1_700)).toMatchObject({
      status: "unknown",
      expectedActiveCount: activeIds.length,
      presentActiveCount: 0,
      missingActiveIds: [],
      observedAt: 1_700,
    });
    expect(unknownActivePriceCoverageHealth(1_800)).toMatchObject({
      status: "unknown",
      expectedActiveCount: null,
      pricedActiveCount: null,
      missingActiveIds: [],
      alertEligibleIds: [],
      acknowledgedGapIds: [],
      observedAt: 1_800,
    });
  });

  it("falls back to unknown health per evidence kind when payloads are missing or not records", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, '["activePublicationCoverage","activePriceCoverage"]');
    let result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toMatchObject({ status: "unknown", observedAt: 100 });
    expect(result.activePriceCoverage).toMatchObject({ status: "unknown", observedAt: 100 });

    insertRun(sqlite, "sync-stablecoins", 200, {
      activePublicationCoverage: "nope",
      activePriceCoverage: priceCoverage(),
    });
    result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toMatchObject({ status: "unknown", observedAt: 200 });
    expect(result.activePriceCoverage).toMatchObject({ status: "complete", observedAt: 200 });

    insertRun(sqlite, "sync-stablecoins", 300, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: null,
    });
    result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toMatchObject({ status: "complete", observedAt: 300 });
    expect(result.activePriceCoverage).toMatchObject({ status: "unknown", observedAt: 300 });

    insertRun(sqlite, "sync-stablecoins", 400, '{"activePublicationCoverage":oops,"activePriceCoverage":2}');
    result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toMatchObject({ status: "unknown", observedAt: 400 });
    expect(result.activePriceCoverage).toMatchObject({ status: "unknown", observedAt: 400 });
  });

  it("zeroes publication counts and keeps id lists empty when coverage numbers are absent", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: {
        complete: true,
        missingActiveIds: "junk",
        waivedActiveIds: 7,
        expiredWaiverIds: null,
      },
      activePriceCoverage: priceCoverage(),
    });
    const result = await loadStablecoinCoverageHealth(db, 1_000);
    expect(result.publication).toEqual({
      status: "incomplete",
      expectedActiveCount: 0,
      presentActiveCount: 0,
      waivedActiveCount: 0,
      missingActiveIds: [],
      waivedActiveIds: [],
      expiredWaiverIds: [],
      observedAt: 100,
    });
  });

  it("marks publication incomplete unless every completeness check passes", async () => {
    const { sqlite, db } = fixtures.open();
    const mutations: Array<Record<string, unknown>> = [
      { complete: false },
      { expectedActiveCount: activeIds.length - 1 },
      { missingActiveIds: [activeIds[0]] },
    ];
    let startedAt = 100;
    for (const override of mutations) {
      insertRun(sqlite, "sync-stablecoins", startedAt, {
        activePublicationCoverage: publicationCoverage(override),
        activePriceCoverage: priceCoverage(),
      });
      const { publication } = await loadStablecoinCoverageHealth(db, 1_000);
      expect(publication.status, `override ${JSON.stringify(override)}`).toBe("incomplete");
      startedAt += 100;
    }
    insertRun(sqlite, "sync-stablecoins", startedAt, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    expect((await loadStablecoinCoverageHealth(db, 1_000)).publication.status).toBe("complete");
  });

  it.each([
    { affectedMarketCapUsd: "unreadable" },
    { affectedMarketCapUsd: undefined },
    { expectedActiveCount: undefined },
    { missingActiveAssets: [{ stablecoinId: activeIds[0] }] },
  ])("withholds malformed coverage rather than zero-filling it: %j", async (override) => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(override),
    });
    expect((await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage).toMatchObject({
      status: "unknown",
      unavailableReason: "coverage-malformed",
      expectedActiveCount: null,
      missingPriceCount: null,
      affectedMarketCapUsd: null,
    });
  });

  it("withholds non-array missing-price evidence", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({
        complete: false,
        missingActiveState: "junk",
        missingActiveAssets: 42,
      }),
    });

    const price = (await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage;
    expect(price.status).toBe("unknown");
    expect(price.unavailableReason).toBe("coverage-malformed");
    expect(price.alertEligibleCount).toBeNull();
    expect(price.maxConsecutiveMissingGenerations).toBeNull();
  });

  it("caps parsed missing price state at the active registry size", async () => {
    const { sqlite, db } = fixtures.open();
    const state = Array.from({ length: activeIds.length + 2 }, (_, index) => [
      `overflow-${index}`,
      1,
      null,
      null,
      null,
      null,
    ]);
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({ complete: false, missingActiveState: state }),
    });

    const price = (await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage;
    expect(price.missingActiveAssets).toHaveLength(activeIds.length);
    expect(price.missingActiveAssets[0]?.stablecoinId).toBe("overflow-0");
    expect(price.missingActiveAssets[price.missingActiveAssets.length - 1]?.stablecoinId).toBe(
      `overflow-${activeIds.length - 1}`,
    );
  });


  it("marks price coverage incomplete unless every completeness check passes", async () => {
    const { sqlite, db } = fixtures.open();
    const mutations: Array<Record<string, unknown>> = [
      { complete: false },
      { expectedActiveCount: activeIds.length - 1 },
      { presentActiveCount: activeIds.length - 1 },
      { pricedActiveCount: activeIds.length - 1 },
      { pricedActiveIds: activeIds.slice(0, -1) },
      { pricedActiveIds: [...activeIds.slice(0, -1), activeIds[0]] },
      { pricedActiveIds: [...activeIds.slice(0, -1), "not-in-registry"] },
      { missingPriceCount: 1 },
      { missingActiveIds: [activeIds[0]] },
    ];
    let startedAt = 100;
    for (const override of mutations) {
      insertRun(sqlite, "sync-stablecoins", startedAt, {
        activePublicationCoverage: publicationCoverage(),
        activePriceCoverage: priceCoverage(override),
      });
      const { activePriceCoverage } = await loadStablecoinCoverageHealth(db, 1_000);
      expect(activePriceCoverage.status, `override ${JSON.stringify(override)}`).toBe("incomplete");
      startedAt += 100;
    }
    insertRun(sqlite, "sync-stablecoins", startedAt, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    expect((await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage.status).toBe("complete");
  });

  it("recomputes reviews for compact legacy state and re-arms an acknowledged streak at exact expiry", async () => {
    const { sqlite, db } = fixtures.open();
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
    insertRun(sqlite, "sync-stablecoins", review.expiresAt - 60, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({
        complete: false,
        pricedActiveCount: activeIds.length - 1,
        pricedActiveIds: activeIds.filter((id) => id !== review.stablecoinId),
        missingActiveIds: [review.stablecoinId],
        missingPriceCount: 1,
        missingActiveState: [[review.stablecoinId, 800, 0.99, "coingecko", review.reviewedAt, "no-accepted-price"]],
        // An acknowledged producer writes zero eligible IDs. The compact
        // streak, not this persisted decision, must re-arm at expiry.
        alertEligibleIds: [],
        alertEligibleCount: 0,
      }),
    });
    const before = (await loadStablecoinCoverageHealth(db, review.expiresAt - 1)).activePriceCoverage;
    expect(before).toMatchObject({
      status: "incomplete",
      missingPriceCount: 1,
      acknowledgedGapIds: [review.stablecoinId],
      alertEligibleIds: [],
      alertEligibleCount: 0,
    });
    expect(before.missingActiveAssets[0]).toMatchObject({
      acknowledgedGap: { owner: review.owner, expiresAt: review.expiresAt },
      alertEligible: false,
    });
    const after = (await loadStablecoinCoverageHealth(db, review.expiresAt)).activePriceCoverage;
    expect(after).toMatchObject({
      missingPriceCount: 1,
      acknowledgedGapIds: [],
      alertEligibleIds: [review.stablecoinId],
      alertEligibleCount: 1,
    });
    expect(after.expiredGapReviewIds).toContain(review.stablecoinId);
    expect(after.missingActiveAssets[0]?.acknowledgedGap).toBeNull();
  });

  it("exposes the publication slice through loadStablecoinPublicationHealth", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage(),
    });
    expect(await loadStablecoinPublicationHealth(db, 1_000)).toMatchObject({
      status: "complete",
      observedAt: 100,
    });
  });
});
