import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { getDatasetFreshness } from "../derived-data";

const NOW = 1_800_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function publishedPointer(updatedAt: number) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: 2,
      stablecoinIdsDigest: "a".repeat(64),
    }),
    updated_at: updatedAt,
  };
}

describe("getDatasetFreshness", () => {
  it("fails closed for safety freshness when the compact cache has no identity instead of reading legacy history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [{
          key: "report_card_cache",
          value: JSON.stringify({
            methodologyVersion: "v8-test",
            updatedAt: NOW - 60,
            scores: { "usdc-circle": { score: 99, grade: "A+" } },
          }),
          updated_at: NOW - 60,
        }],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.safetyGrades).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("uses the DEWS publication pointer and never a newer partial table timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const publishedAt = NOW - 300;
    const pointer = publishedPointer(publishedAt);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "FROM stress_signals",
        first: { latest: NOW - 10 },
        rows: [],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.dews).toBe(publishedAt);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("reports DEWS freshness as unavailable without valid publication evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: null,
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.dews).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });
});
