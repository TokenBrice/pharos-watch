import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { mockD1 } from "@shared/test-utils/mock-d1";
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
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              methodologyVersion: "v8-test",
              updatedAt: NOW - 60,
              scores: { "usdc-circle": { score: 99, grade: "A+" } },
            }),
            updated_at: NOW - 60,
          },
        ],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.safetyGrades).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("keeps dataset freshness available when the report-card cache read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [],
        throwError: "report-card cache unavailable",
      },
    ]);

    await expect(getDatasetFreshness(db)).resolves.toMatchObject({
      safetyGrades: null,
    });
  });

  it("fails closed for safety freshness when the V8 release sees a complete V9 compact publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const updatedAt = NOW - 60;
    const publicationGenerationId = `safety-score-v9:9.0:${updatedAt}`;
    const scoreIds = [...ACTIVE_IDS].sort();
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
              updatedAt,
              scores: Object.fromEntries(scoreIds.map((id) => [id, { score: 99, grade: "A+" }])),
              safetyScoreIdentity: {
                model: "v9",
                schemaVersion: 1,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                policyId: "v9-policy-2026-05",
                policyDigest: "b".repeat(64),
                evaluationBuildDigest: "c".repeat(64),
                baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
                publicationGenerationId,
              },
              publicationGenerationId,
              completeness: {
                generationId: publicationGenerationId,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                expectedCount: scoreIds.length,
                scoredCount: scoreIds.length,
                notRatedCount: 0,
                notRatedIds: [],
              },
            }),
            updated_at: updatedAt,
          },
        ],
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
