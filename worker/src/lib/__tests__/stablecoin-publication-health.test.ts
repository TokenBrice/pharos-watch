import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { afterEach, describe, expect, it } from "vitest";
import { loadStablecoinCoverageHealth } from "../stablecoin-publication-health";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("stablecoin publication health", () => {
  it("selects exact publication evidence over wrappers, other jobs, partial evidence and timestamp ties", async () => {
    const { sqlite, db } = fixtures.open();
    const activeIds = [...ACTIVE_IDS];
    const coverage = {
      complete: true, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      waivedActiveCount: 0, missingActiveIds: [], waivedActiveIds: [], expiredWaiverIds: [],
    };
    const price = {
      complete: true, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      pricedActiveCount: activeIds.length, pricedActiveIds: activeIds, missingPriceCount: 0, missingActiveIds: [],
    };
    const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES (?, ?, 0, 'ok', ?)");
    insert.run("sync-stablecoins", 100, JSON.stringify({ activePublicationCoverage: coverage, activePriceCoverage: price }));
    insert.run("sync-stablecoins", 200, JSON.stringify({ activePublicationCoverage: { ...coverage, complete: false }, activePriceCoverage: price }));
    insert.run("sync-stablecoins", 200, JSON.stringify({ activePublicationCoverage: coverage, activePriceCoverage: price }));
    insert.run("sync-stablecoins", 300, JSON.stringify({ childDisposition: "abandoned" }));
    insert.run("other-job", 400, JSON.stringify({ activePublicationCoverage: coverage, activePriceCoverage: price }));
    insert.run("sync-stablecoins", 500, JSON.stringify({ activePublicationCoverage: coverage }));
    insert.run("sync-stablecoins", 600, JSON.stringify({ activePriceCoverage: price }));

    const result = await loadStablecoinCoverageHealth(db);
    expect(result.publication).toMatchObject({ status: "complete", observedAt: 200 });
    expect(result.activePriceCoverage).toMatchObject({ status: "complete", observedAt: 200 });
  });
});
