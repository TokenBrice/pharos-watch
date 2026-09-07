import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findD1HistoryEntry } from "@shared/test-utils/mock-d1";
import { makePsiDailyDb, makePsiSnapshotDb, type MockD1Database } from "./snapshot-cron.test-support";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { snapshotPsiDaily } from "../snapshot-psi";

const mockD1 = makePsiSnapshotDb;

function yesterdayMidnightFrom(nowMs: number): number {
  const now = Math.floor(nowMs / 1000);
  const todayMidnight = now - (now % 86_400);
  return todayMidnight - 86_400;
}

const getInsertBinds = (db: MockD1Database) => findD1HistoryEntry(db, "INSERT INTO stability_index")?.binds;

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

    await expect(snapshotPsiDaily(mockD1(), controller.signal)).rejects.toThrow("snapshot psi aborted");
  });

  it("computes yesterday average from 96 samples and inserts stability_index row", async () => {
    const db = makePsiDailyDb({
      average: {
        avg_score: 87.44,
        avg_severity: 5.12,
        avg_breadth: 2.34,
        avg_stress_breadth: 1.11,
        avg_trend: 0.56,
        cnt: 96,
      },
      methodologyRows: [{ methodology_version: "psi-v3", cnt: 96 }],
    });

    const result = await snapshotPsiDaily(db);

    expect(result.metadata).toContain("avg=87.4");
    expect(result.metadata).toContain("samples=96");

    const binds = getInsertBinds(db as MockD1Database);
    const expectedComputedAt = yesterdayMidnightFrom(Date.now());

    expect(binds).toBeDefined();
    expect(binds?.[0]).toBe(expectedComputedAt);
    expect(binds?.[1]).toBe(87.4);
    expect(binds?.[2]).toBe("STEADY");

    const components = JSON.parse(String(binds?.[3])) as Record<string, number>;
    expect(components).toEqual({
      severity: 5.12,
      breadth: 2.34,
      stressBreadth: 1.11,
      trend: 0.56,
    });

    const inputSnapshot = JSON.parse(String(binds?.[4])) as {
      source: string;
      sampleCount: number;
      methodologyVersion: string;
      methodologyBreakdown: Record<string, number>;
    };
    expect(inputSnapshot.source).toBe("daily-avg");
    expect(inputSnapshot.sampleCount).toBe(96);
    expect(inputSnapshot.methodologyVersion).toBe("psi-v3");
    expect(inputSnapshot.methodologyBreakdown).toEqual({ "psi-v3": 96 });
    expect(binds?.[5]).toBe("psi-v3");
  });

  it("returns skipped metadata and does not insert when sample set is empty", async () => {
    const db = makePsiDailyDb({
      average: {
        avg_score: null,
        avg_severity: null,
        avg_breadth: null,
        avg_stress_breadth: null,
        avg_trend: null,
        cnt: 0,
      },
      methodologyRows: [],
    });

    const result = await snapshotPsiDaily(db);

    expect(result.status).toBe("degraded");
    expect(result.metadata).toBe(JSON.stringify({ reason: "no-samples-for-yesterday", sampleCount: 0 }));
    const insert = findD1HistoryEntry(db, "INSERT INTO stability_index");
    expect(insert).toBeUndefined();
  });

  it("uses the most common methodology version when multiple versions exist", async () => {
    const db = makePsiDailyDb({
      average: {
        avg_score: 92,
        avg_severity: 2,
        avg_breadth: 1,
        avg_stress_breadth: 0.5,
        avg_trend: 1.5,
        cnt: 96,
      },
      methodologyRows: [
        { methodology_version: "psi-v4", cnt: 60 },
        { methodology_version: "psi-v3", cnt: 36 },
      ],
    });

    await snapshotPsiDaily(db);

    const binds = getInsertBinds(db as MockD1Database);
    expect(binds?.[5]).toBe("psi-v4");
    const inputSnapshot = JSON.parse(String(binds?.[4])) as {
      methodologyVersion: string;
      methodologyBreakdown: Record<string, number>;
    };
    expect(inputSnapshot.methodologyVersion).toBe("psi-v4");
    expect(inputSnapshot.methodologyBreakdown).toEqual({
      "psi-v4": 60,
      "psi-v3": 36,
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

  function seedSample(sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"], storedAt: number, score: number): void {
    sqlite
      .prepare(
        `INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot, methodology_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        storedAt,
        score,
        "STEADY",
        JSON.stringify({ severity: 5, breadth: 2, stressBreadth: 1, trend: 0.5 }),
        "{}",
        "psi-v3",
      );
  }

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
