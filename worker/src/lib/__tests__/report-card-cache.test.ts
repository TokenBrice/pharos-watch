import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { loadReportCardCache } from "../report-card-cache";

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
});
