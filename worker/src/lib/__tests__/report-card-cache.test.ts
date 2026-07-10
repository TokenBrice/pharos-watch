import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadReportCardCache, REPORT_CARD_CACHE_GENERATION, writeReportCardCache } from "../report-card-cache";

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
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
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
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      }), rowUpdatedAt),
    );

    expect(result).toEqual({
      kind: "ok",
      payload: {
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: payloadUpdatedAt,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      },
      updatedAt: payloadUpdatedAt,
    });
  });

  it("rejects cache payloads from older Safety Score methodologies", async () => {
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        scores: {
          "usdt-tether": { score: 73, grade: "B+" },
        },
        updatedAt: 1_700_000_000,
        methodologyVersion: "7.29",
      })),
    );

    expect(result).toEqual({
      kind: "error",
      reason: "methodology-mismatch",
      updatedAt: 1_700_000_000,
    });
  });

  it("rejects legacy cache payloads without methodology version", async () => {
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        scores: {
          "usdt-tether": { score: 73, grade: "B+" },
        },
        updatedAt: 1_700_000_000,
      })),
    );

    expect(result).toEqual({
      kind: "error",
      reason: "methodology-mismatch",
      updatedAt: 1_700_000_000,
    });
  });

  it("accepts degraded input metadata on cache payloads", async () => {
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: 1_700_000_000,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        degradedInputs: {
          inputsStale: true,
          liquidityStale: false,
          redemptionStale: true,
          staleInputs: ["redemptionBackstops"],
        },
      })),
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.payload.degradedInputs).toEqual({
        inputsStale: true,
        liquidityStale: false,
        redemptionStale: true,
        staleInputs: ["redemptionBackstops"],
      });
    }
  });

  it("accepts the future versioned score-cache envelope without changing the load result shape", async () => {
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        generation: REPORT_CARD_CACHE_GENERATION,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        payload: {
          scores: {
            "usdt-tether": { score: 71, grade: "B" },
          },
          updatedAt: 1_700_000_000,
          degradedInputs: {
            inputsStale: true,
            liquidityStale: true,
            redemptionStale: false,
            staleInputs: ["dexLiquidity"],
          },
        },
      })),
    );

    expect(result).toEqual({
      kind: "ok",
      payload: {
        scores: {
          "usdt-tether": { score: 71, grade: "B" },
        },
        updatedAt: 1_700_000_000,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        degradedInputs: {
          inputsStale: true,
          liquidityStale: true,
          redemptionStale: false,
          staleInputs: ["dexLiquidity"],
        },
      },
      updatedAt: 1_700_000_000,
    });
  });

  it("rejects future versioned score-cache envelopes from other generations", async () => {
    const result = await loadReportCardCache(
      makeReportCardDb(JSON.stringify({
        generation: REPORT_CARD_CACHE_GENERATION + 1,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        payload: {
          scores: {
            "usdt-tether": { score: 71, grade: "B" },
          },
          updatedAt: 1_700_000_000,
        },
      })),
    );

    expect(result).toEqual({
      kind: "error",
      reason: "generation-mismatch",
      updatedAt: 1_700_000_000,
    });
  });
});

describe("writeReportCardCache", () => {
  it("writes scored non-defunct cards with degraded input metadata", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO cache", rows: [] }]);

    const result = await writeReportCardCache(db, [
      { id: "rated", overallScore: 82, overallGrade: "B+", isDefunct: false },
      { id: "nr", overallScore: null, overallGrade: "NR", isDefunct: false },
      { id: "dead", overallScore: 0, overallGrade: "F", isDefunct: true },
    ] as never, 1_777_000_000, {
      liquidityStale: true,
      redemptionStale: false,
      completeness: {
        generationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1777000000`,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        expectedCount: 2,
        scoredCount: 1,
        notRatedCount: 1,
        notRatedIds: ["nr"],
      },
    });

    expect(result.writtenCount).toBe(1);
    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(write?.binds[0]).toBe("report_card_cache");
    expect(JSON.parse(String(write?.binds[1]))).toEqual({
      generation: REPORT_CARD_CACHE_GENERATION,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      payload: {
        scores: {
          rated: { score: 82, grade: "B+" },
        },
        updatedAt: 1_777_000_000,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1777000000`,
        completeness: {
          generationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1777000000`,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          expectedCount: 2,
          scoredCount: 1,
          notRatedCount: 1,
          notRatedIds: ["nr"],
        },
        degradedInputs: {
          inputsStale: true,
          liquidityStale: true,
          redemptionStale: false,
          staleInputs: ["dexLiquidity"],
        },
      },
    });
  });
});
