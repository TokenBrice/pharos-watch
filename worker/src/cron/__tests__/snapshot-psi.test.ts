import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { snapshotPsiDaily } from "../snapshot-psi";

function mockD1(tables: Parameters<typeof createMockD1>[0] = []) {
  return createMockD1([
    ...tables,
    { match: "INSERT OR REPLACE INTO stability_index", rows: [] },
  ]);
}

function yesterdayMidnightFrom(nowMs: number): number {
  const now = Math.floor(nowMs / 1000);
  const todayMidnight = now - (now % 86_400);
  return todayMidnight - 86_400;
}

function getInsertBinds(db: MockD1Database): unknown[] | undefined {
  const write = db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index"));
  return write?.binds;
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

    await expect(snapshotPsiDaily(mockD1(), controller.signal)).rejects.toThrow("snapshot psi aborted");
  });

  it("computes yesterday average from 96 samples and inserts stability_index row", async () => {
    const db = mockD1([
      {
        match: "AVG(score) as avg_score",
        rows: [],
        first: {
          avg_score: 87.44,
          avg_severity: 5.12,
          avg_breadth: 2.34,
          avg_stress_breadth: 1.11,
          avg_trend: 0.56,
          cnt: 96,
        },
      },
      {
        match: "GROUP BY methodology_version",
        rows: [{ methodology_version: "psi-v3", cnt: 96 }],
      },
    ]);

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
    const db = mockD1([
      {
        match: "AVG(score) as avg_score",
        rows: [],
        first: {
          avg_score: null,
          avg_severity: null,
          avg_breadth: null,
          avg_stress_breadth: null,
          avg_trend: null,
          cnt: 0,
        },
      },
      {
        match: "GROUP BY methodology_version",
        rows: [],
      },
    ]);

    const result = await snapshotPsiDaily(db);

    expect(result.status).toBe("degraded");
    expect(result.metadata).toBe(JSON.stringify({ reason: "no-samples-for-yesterday", sampleCount: 0 }));
    const insert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index"));
    expect(insert).toBeUndefined();
  });

  it("uses the most common methodology version when multiple versions exist", async () => {
    const db = mockD1([
      {
        match: "AVG(score) as avg_score",
        rows: [],
        first: {
          avg_score: 92,
          avg_severity: 2,
          avg_breadth: 1,
          avg_stress_breadth: 0.5,
          avg_trend: 1.5,
          cnt: 96,
        },
      },
      {
        match: "GROUP BY methodology_version",
        rows: [
          { methodology_version: "psi-v4", cnt: 60 },
          { methodology_version: "psi-v3", cnt: 36 },
        ],
      },
    ]);

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
