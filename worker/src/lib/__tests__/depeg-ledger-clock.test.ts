import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  latestDepegLedgerRun,
  loadDepegCensusRuns,
  loadLatestDepegLedgerRunAt,
} from "../depeg-ledger-clock";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
});

const NOW = 1_775_900_000;

function censusJson(): string {
  return JSON.stringify({
    scope: "psi-non-nav-before-supply-floor",
    evaluatedAt: NOW - 4_500,
    eligibleCount: 100,
    observedCount: 98,
    unavailableCount: 2,
    belowFloorCount: 0,
    reasonCounts: { "asset-absent": 2 },
  });
}

describe("depeg ledger clock", () => {
  it("keeps the newest completed census visible past the recent-run read window", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
       VALUES ('sync-stablecoins', ?, 1000, 'ok', 0, ?)`,
    );
    for (let run = 1; run <= 4; run++) {
      insert.run(
        NOW - run * 900,
        JSON.stringify({
          capabilities: { depegPipeline: false },
          quality: { depegObservationUnavailableReason: "depeg-detection-held" },
        }),
      );
    }
    const completedAt = NOW - 5 * 900;
    insert.run(
      completedAt,
      JSON.stringify({
        capabilities: { depegPipeline: true },
        quality: { depegObservation: JSON.parse(censusJson()) },
      }),
    );

    expect(latestDepegLedgerRun(await loadDepegCensusRuns(db))).toBeNull();
    expect(await loadLatestDepegLedgerRunAt(db)).toBe(completedAt);
  });

  it("ignores completed runs whose census is absent or malformed", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
       VALUES ('sync-stablecoins', ?, 1000, 'ok', 0, ?)`,
    );
    insert.run(
      NOW - 60,
      JSON.stringify({ capabilities: { depegPipeline: true }, quality: { depegObservation: null } }),
    );
    insert.run(
      NOW - 900,
      JSON.stringify({ capabilities: { depegPipeline: true }, quality: { depegObservation: { scope: "wrong" } } }),
    );
    const completedAt = NOW - 1_800;
    insert.run(
      completedAt,
      JSON.stringify({
        capabilities: { depegPipeline: true },
        quality: { depegObservation: JSON.parse(censusJson()) },
      }),
    );

    expect(await loadLatestDepegLedgerRunAt(db)).toBe(completedAt);
  });
});
