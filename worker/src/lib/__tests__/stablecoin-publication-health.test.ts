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
      expectedActiveCount: activeIds.length,
      pricedActiveCount: 0,
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

  it("parses missing price state and asset details with fallbacks and asset precedence", async () => {
    const { sqlite, db } = fixtures.open();
    const trackedId = activeIds[0];
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({
        complete: false,
        pricedActiveCount: activeIds.length - 2,
        pricedActiveIds: activeIds.slice(2),
        // missingPriceCount omitted: derived from missingActiveIds.length
        missingActiveIds: [],
        affectedMarketCapUsd: 123.5,
        missingActiveState: [
          [trackedId, 2, 1.5, "pyth", 1_700, "stale-price"],
          ["ghost-usd", 0, null, 7, null, null],
          // Skipped: first entry not a string id, too short, not an array.
          [1, 2, 3, 4, 5, 6],
          ["x", 1, 2, 3, 4],
          "junk",
        ],
        missingActiveAssets: [
          {
            stablecoinId: trackedId,
            symbol: "TRACK",
            marketCapUsd: 5_000_000_000,
            currentPrice: 0.99,
            currentSource: "coinbase",
            currentObservedAt: 1_800,
            currentConfidence: "high",
            consecutiveMissingGenerations: 5,
            lastAcceptedPrice: 1.001,
            lastAcceptedSource: "binance",
            lastAcceptedObservedAt: 1_750,
            rejectionReason: "depegged",
            alertEligible: false,
          },
          {
            stablecoinId: "ghost-usd",
            consecutiveMissingGenerations: 1,
          },
          {
            stablecoinId: "ghost-2",
            consecutiveMissingGenerations: 1,
            alertEligible: true,
          },
          // Skipped: not a record, record without stablecoinId.
          "junk",
          { symbol: "NOPE" },
        ],
        // alertEligibleCount/alertEligibleIds/maxConsecutiveMissingGenerations
        // omitted: derived from the parsed missing assets.
        alertEligibleCount: undefined,
        alertEligibleIds: undefined,
        maxConsecutiveMissingGenerations: undefined,
      }),
    });

    const price = (await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage;
    expect(price.status).toBe("incomplete");
    expect(price.pricedActiveCount).toBe(activeIds.length - 2);
    expect(price.pricedActiveIds).toEqual(activeIds.slice(2));
    expect(price.missingPriceCount).toBe(0);
    expect(price.missingActiveIds).toEqual([]);
    expect(price.affectedMarketCapUsd).toBe(123.5);
    // Asset details win over compact state rows for the same stablecoin.
    expect(price.missingActiveAssets).toEqual([
      {
        stablecoinId: trackedId,
        symbol: "TRACK",
        marketCapUsd: 5_000_000_000,
        currentPrice: 0.99,
        currentSource: "coinbase",
        currentObservedAt: 1_800,
        currentConfidence: "high",
        consecutiveMissingGenerations: 5,
        lastAcceptedPrice: 1.001,
        lastAcceptedSource: "binance",
        lastAcceptedObservedAt: 1_750,
        rejectionReason: "depegged",
        alertEligible: true,
        acknowledgedGap: null,
      },
      {
        stablecoinId: "ghost-usd",
        symbol: "ghost-usd",
        marketCapUsd: null,
        currentPrice: null,
        currentSource: null,
        currentObservedAt: null,
        currentConfidence: null,
        consecutiveMissingGenerations: 1,
        lastAcceptedPrice: null,
        lastAcceptedSource: null,
        lastAcceptedObservedAt: null,
        rejectionReason: "no-accepted-price",
        alertEligible: false,
        acknowledgedGap: null,
      },
      {
        stablecoinId: "ghost-2",
        symbol: "ghost-2",
        marketCapUsd: null,
        currentPrice: null,
        currentSource: null,
        currentObservedAt: null,
        currentConfidence: null,
        consecutiveMissingGenerations: 1,
        lastAcceptedPrice: null,
        lastAcceptedSource: null,
        lastAcceptedObservedAt: null,
        rejectionReason: "no-accepted-price",
        alertEligible: true,
        acknowledgedGap: null,
      },
    ]);
    expect(price.alertEligibleIds).toEqual([trackedId, "ghost-2"]);
    expect(price.alertEligibleCount).toBe(2);
    expect(price.maxConsecutiveMissingGenerations).toBe(5);
  });

  it("retains explicit eligible IDs but derives their count instead of trusting contradictory metadata", async () => {
    const { sqlite, db } = fixtures.open();
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({
        complete: false,
        missingActiveIds: [activeIds[1], "never-parsed"],
        missingPriceCount: 2,
        missingActiveAssets: [
          {
            stablecoinId: activeIds[1],
            symbol: "MISS",
            marketCapUsd: null,
            currentPrice: null,
            currentSource: null,
            currentObservedAt: null,
            currentConfidence: null,
            consecutiveMissingGenerations: 1,
            alertEligible: false,
          },
        ],
        alertEligibleIds: ["somewhere-else"],
        alertEligibleCount: 9,
        maxConsecutiveMissingGenerations: 7,
        affectedMarketCapUsd: 5,
      }),
    });

    const price = (await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage;
    expect(price.status).toBe("incomplete");
    expect(price.missingActiveIds).toEqual([activeIds[1], "never-parsed"]);
    expect(price.missingActiveAssets).toEqual([
      {
        stablecoinId: activeIds[1],
        symbol: "MISS",
        marketCapUsd: null,
        currentPrice: null,
        currentSource: null,
        currentObservedAt: null,
        currentConfidence: null,
        consecutiveMissingGenerations: 1,
        lastAcceptedPrice: null,
        lastAcceptedSource: null,
        lastAcceptedObservedAt: null,
        rejectionReason: "no-accepted-price",
        alertEligible: false,
        acknowledgedGap: null,
      },
    ]);
    expect(price.alertEligibleIds).toEqual(["somewhere-else"]);
    expect(price.alertEligibleCount).toBe(1);
    expect(price.maxConsecutiveMissingGenerations).toBe(7);
  });

  it("treats non-array missing-price evidence as empty", async () => {
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
    expect(price.status).toBe("incomplete");
    expect(price.missingActiveAssets).toEqual([]);
    expect(price.alertEligibleIds).toEqual([]);
    expect(price.alertEligibleCount).toBe(0);
    expect(price.maxConsecutiveMissingGenerations).toBe(0);
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

  it("applies the writer sanitizer to missing-price details", async () => {
    const { sqlite, db } = fixtures.open();
    const trackedId = activeIds[0]!;
    insertRun(sqlite, "sync-stablecoins", 100, {
      activePublicationCoverage: publicationCoverage(),
      activePriceCoverage: priceCoverage({
        complete: false,
        missingActiveIds: [trackedId],
        missingPriceCount: 1,
        missingActiveAssets: [{
          stablecoinId: trackedId,
          symbol: "   ",
          currentSource: "",
          currentConfidence: "  ",
          currentObservedAt: 9_000_000_000_000_000,
          lastAcceptedPrice: -1,
          lastAcceptedSource: "\t",
          lastAcceptedObservedAt: -9_000_000_000_000_000,
          rejectionReason: " ",
          consecutiveMissingGenerations: 1,
        }],
      }),
    });

    const price = (await loadStablecoinCoverageHealth(db, 1_000)).activePriceCoverage;
    expect(price.missingActiveAssets).toEqual([expect.objectContaining({
      stablecoinId: trackedId,
      symbol: trackedId,
      currentSource: null,
      currentConfidence: null,
      currentObservedAt: null,
      lastAcceptedPrice: null,
      lastAcceptedSource: null,
      lastAcceptedObservedAt: null,
      rejectionReason: "no-accepted-price",
    })]);
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
