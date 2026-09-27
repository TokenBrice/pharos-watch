import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { snapshotPsiDaily } from "../snapshot-psi";

const fixtures = createLatestSchemaFixtureTracker();
const createLatestSchemaSqlite = fixtures.open;
afterEach(fixtures.closeAll);

function yesterdayMidnightFrom(nowMs: number): number {
  const now = Math.floor(nowMs / 1000);
  const todayMidnight = now - (now % 86_400);
  return todayMidnight - 86_400;
}
function seedSample(
  sqlite: DatabaseSync,
  storedAt: number,
  score: number,
  methodologyVersion = "psi-v3",
): void {
  sqlite.prepare(
    `INSERT INTO stability_index_samples
       (stored_at, score, band, components, input_snapshot, methodology_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    storedAt,
    score,
    "STEADY",
    JSON.stringify({ severity: 5, breadth: 2, stressBreadth: 1, trend: 0.5 }),
    "{}",
    methodologyVersion,
  );
}


describe("snapshotPsiDaily", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("snapshot psi aborted"));

    await expect(snapshotPsiDaily(mockD1Strict(), controller.signal)).rejects.toThrow("snapshot psi aborted");
  });

  it("persists the daily average and its provenance by semantic column", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const computedAt = yesterdayMidnightFrom(Date.now());
    for (let index = 0; index < 96; index++) {
      seedSample(sqlite, computedAt + index * 900, 87.44);
    }

    const result = await snapshotPsiDaily(db, undefined, { completionReason: "same_day_catch_up" });
    const stored = sqlite.prepare(
      `SELECT computed_at, score, band, components, input_snapshot, methodology_version
       FROM stability_index
       WHERE computed_at = ?`,
    ).get(computedAt) as {
      computed_at: number;
      score: number;
      band: string;
      components: string;
      input_snapshot: string;
      methodology_version: string;
    };

    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "same_day_catch_up",
      avgScore: 87.4,
      band: "STEADY",
      sampleCount: 96,
    });
    expect(stored).toMatchObject({
      computed_at: computedAt,
      score: 87.4,
      band: "STEADY",
      methodology_version: "psi-v3",
    });
    expect(JSON.parse(stored.components)).toEqual({
      severity: 5,
      breadth: 2,
      stressBreadth: 1,
      trend: 0.5,
    });
    expect(JSON.parse(stored.input_snapshot)).toMatchObject({
      source: "daily-avg",
      sampleCount: 96,
      methodologyVersion: "psi-v3",
      methodologyBreakdown: { "psi-v3": 96 },
    });
  });

  it("returns skipped metadata and leaves no daily row when the sample set is empty", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    const result = await snapshotPsiDaily(db);

    expect(result.status).toBe("degraded");
    expect(result.metadata).toBe(JSON.stringify({ reason: "no-samples-for-yesterday", sampleCount: 0 }));
    expect(sqlite.prepare("SELECT * FROM stability_index").all()).toEqual([]);
  });

  it("persists the most common methodology version when multiple versions exist", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const computedAt = yesterdayMidnightFrom(Date.now());
    for (let index = 0; index < 60; index++) {
      seedSample(sqlite, computedAt + index * 600, 92, "psi-v4");
    }
    for (let index = 60; index < 96; index++) {
      seedSample(sqlite, computedAt + index * 600, 72, "psi-v3");
    }

    await snapshotPsiDaily(db);

    const stored = sqlite.prepare(
      "SELECT score, methodology_version, input_snapshot FROM stability_index WHERE computed_at = ?",
    ).get(computedAt) as { score: number; methodology_version: string; input_snapshot: string };
    expect(stored.methodology_version).toBe("psi-v4");
    expect(stored.score).toBe(84.5);
    expect(JSON.parse(stored.input_snapshot)).toMatchObject({
      aggregation: "all-day",
      sampleCount: 96,
      componentSampleCounts: { severity: 96, breadth: 96, stressBreadth: 96, trend: 96 },
      methodologyVersion: "psi-v4",
      methodologyBreakdown: {
        "psi-v4": 60,
        "psi-v3": 36,
      },
    });
  });

  it("persists all-null components as null, observed zero as zero, and partial observed averages with counts", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const computedAt = yesterdayMidnightFrom(Date.now());
    seedSample(sqlite, computedAt + 900, 80);
    seedSample(sqlite, computedAt + 1800, 90);
    sqlite.prepare("UPDATE stability_index_samples SET components = ? WHERE stored_at = ?")
      .run(JSON.stringify({ severity: null, breadth: 0, trend: 2 }), computedAt + 900);
    sqlite.prepare("UPDATE stability_index_samples SET components = ? WHERE stored_at = ?")
      .run(JSON.stringify({ breadth: 0, stressBreadth: 4, trend: 4 }), computedAt + 1800);

    await snapshotPsiDaily(db);
    const row = sqlite.prepare("SELECT score, components, input_snapshot FROM stability_index WHERE computed_at = ?")
      .get(computedAt) as { score: number; components: string; input_snapshot: string };
    expect(row.score).toBe(85);
    expect(JSON.parse(row.components)).toEqual({ severity: null, breadth: 0, stressBreadth: 4, trend: 3 });
    expect(JSON.parse(row.input_snapshot)).toMatchObject({
      sampleCount: 2,
      componentSampleCounts: { severity: 0, breadth: 2, stressBreadth: 1, trend: 2 },
    });
  });

  it("preserves the existing daily row when a source read fails", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const computedAt = yesterdayMidnightFrom(Date.now());
    seedSample(sqlite, computedAt + 900, 80);
    await snapshotPsiDaily(db);
    const before = sqlite.prepare("SELECT * FROM stability_index WHERE computed_at = ?").get(computedAt);
    seedSample(sqlite, computedAt + 1800, 20);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("GROUP BY methodology_version")) throw new Error("injected source read failure");
      return prepare(sql);
    });

    const result = await snapshotPsiDaily(db);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}").reason).toBe("db_query_failed");
    expect(sqlite.prepare("SELECT * FROM stability_index WHERE computed_at = ?").all(computedAt)).toEqual([before]);
  });
});

describe("snapshotPsiDaily re-run idempotency (real schema)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });


  it("leaves exactly one row for the day when the daily aggregation re-runs", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const yesterdayMidnight = yesterdayMidnightFrom(Date.now());

    seedSample(sqlite, yesterdayMidnight + 3_600, 90);
    seedSample(sqlite, yesterdayMidnight + 7_200, 80);

    await snapshotPsiDaily(db);
    await snapshotPsiDaily(db);

    const rows = sqlite
      .prepare("SELECT computed_at, score FROM stability_index WHERE computed_at = ?")
      .all(yesterdayMidnight) as { computed_at: number; score: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(85);
  });

  it("replaces the stored row when a re-run produces a different score", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const yesterdayMidnight = yesterdayMidnightFrom(Date.now());

    seedSample(sqlite, yesterdayMidnight + 3_600, 90);
    await snapshotPsiDaily(db);

    seedSample(sqlite, yesterdayMidnight + 7_200, 70);
    await snapshotPsiDaily(db);

    const rows = sqlite
      .prepare("SELECT score FROM stability_index WHERE computed_at = ?")
      .all(yesterdayMidnight) as { score: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(80);
  });
});
