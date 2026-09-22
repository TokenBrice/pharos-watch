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
      seedSample(sqlite, computedAt + index * 600, 92, "psi-v3");
    }

    await snapshotPsiDaily(db);

    const stored = sqlite.prepare(
      "SELECT methodology_version, input_snapshot FROM stability_index WHERE computed_at = ?",
    ).get(computedAt) as { methodology_version: string; input_snapshot: string };
    expect(stored.methodology_version).toBe("psi-v4");
    expect(JSON.parse(stored.input_snapshot)).toMatchObject({
      methodologyVersion: "psi-v4",
      methodologyBreakdown: {
        "psi-v4": 60,
        "psi-v3": 36,
      },
    });
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
