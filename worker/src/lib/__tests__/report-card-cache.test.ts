import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { loadReportCardCache, writeReportCardCache } from "../report-card-cache";

function makeReportCardDb(value: string | null, updatedAt = 1_700_000_000): D1Database {
  if (value == null) {
    return mockD1([
      {
        match: "cache",
        matchBinds: ["report_card_cache"],
        rows: [],
        first: null,
      },
    ]);
  }

  return mockD1([
    {
      match: "cache",
      matchBinds: ["report_card_cache"],
      rows: [],
      first: {
        key: "report_card_cache",
        value,
        updated_at: updatedAt,
      },
    },
  ]);
}

describe("loadReportCardCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns missing-cache when the cache row does not exist", async () => {
    const result = await loadReportCardCache(makeReportCardDb(null));

    expect(result).toEqual({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });
  });

  it("returns json-parse-failed when the cache payload is malformed", async () => {
    const result = await loadReportCardCache(makeReportCardDb("{bad json"));

    expect(result).toEqual({
      kind: "error",
      reason: "json-parse-failed",
      updatedAt: 1_700_000_000,
    });
  });

  it("returns stale-cache when the payload is older than the allowed age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T09:00:00Z"));

    const staleUpdatedAt = Math.floor(Date.now() / 1000) - 8 * 3600;
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: staleUpdatedAt,
      }), staleUpdatedAt),
      { maxAgeMs: 2 * 3600 * 1000 },
    );

    expect(result).toEqual({
      kind: "error",
      reason: "stale-cache",
      updatedAt: staleUpdatedAt,
    });
  });

  it("uses the payload snapshot timestamp instead of the cache-row write time", async () => {
    const payloadUpdatedAt = 1_700_000_000;
    const rowUpdatedAt = payloadUpdatedAt + 900;
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: payloadUpdatedAt,
      }), rowUpdatedAt),
    );

    expect(result).toEqual({
      kind: "ok",
      payload: {
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: payloadUpdatedAt,
      },
      updatedAt: payloadUpdatedAt,
    });
  });
});

describe("writeReportCardCache", () => {
  it("writes scored non-defunct cards using the existing cache payload shape", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO cache", rows: [] }]);

    const result = await writeReportCardCache(db, [
      { id: "rated", overallScore: 82, overallGrade: "B+", isDefunct: false },
      { id: "nr", overallScore: null, overallGrade: "NR", isDefunct: false },
      { id: "dead", overallScore: 0, overallGrade: "F", isDefunct: true },
    ] as never, 1_777_000_000);

    expect(result.writtenCount).toBe(1);
    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(write?.binds[0]).toBe("report_card_cache");
    expect(JSON.parse(String(write?.binds[1]))).toEqual({
      scores: {
        rated: { score: 82, grade: "B+" },
      },
      updatedAt: 1_777_000_000,
    });
  });
});
