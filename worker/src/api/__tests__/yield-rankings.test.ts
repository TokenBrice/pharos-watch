import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const buildReportCardsSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    cards: [
      {
        id: "rated-coin",
        symbol: "RATE",
        overallGrade: "B-",
        overallScore: 66,
        isDefunct: false,
      },
      {
        id: "nr-coin",
        symbol: "NRC",
        overallGrade: "NR",
        overallScore: null,
        isDefunct: false,
      },
    ],
  })),
);

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: buildReportCardsSnapshotMock,
}));

import { handleYieldRankings } from "../cache-handlers";

function makeCacheDb(value: unknown, updatedAt: number) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "yield-rankings", value: jsonValue, updated_at: updatedAt }],
      first: { key: "yield-rankings", value: jsonValue, updated_at: updatedAt },
    },
  ]);
}

describe("handleYieldRankings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T16:00:00Z"));
    buildReportCardsSnapshotMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates live safety scores from the report-card snapshot and falls back to NR defaults for missing cards", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb({
      rankings: [
        {
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          currentApy: 5.3,
          apy7d: 5.2,
          apy30d: 5,
          apyBase: 5,
          apyReward: null,
          yieldSource: "Source A",
          yieldType: "lending-vault",
          dataSource: "defillama",
          sourceTvlUsd: 1_000_000,
          pharosYieldScore: 8,
          safetyScore: 40,
          safetyGrade: "NR",
          yieldToRisk: 0.08,
          excessYield: 1,
          yieldStability: 0.8,
          apyVariance30d: 0.5,
          apyMin30d: 4.9,
          apyMax30d: 5.4,
          warningSignals: [],
          altSources: [],
          provenance: {
            sourceKey: "pool-a",
            sourceObservedAt: updatedAt,
            sourceAgeSeconds: 30,
            confidenceTier: "curated",
            selectionMethod: "confidence-weighted",
            selectionReason: "curated canonical source selected by confidence-weighted arbitration",
            sourceSwitch: false,
            previousBestSourceKey: "pool-a",
            usedLegacyHistory: false,
            usedDefaultSafety: true,
            benchmarkRecordDate: "2026-03-12",
            benchmarkIsFallback: false,
            benchmarkFallbackMode: null,
            anomalies: [],
          },
        },
        {
          id: "nr-coin",
          symbol: "NRC",
          name: "NR Coin",
          currentApy: 3.2,
          apy7d: 3.2,
          apy30d: 3.1,
          apyBase: 3.1,
          apyReward: null,
          yieldSource: "Source B",
          yieldType: "lending-vault",
          dataSource: "defillama",
          sourceTvlUsd: 500_000,
          pharosYieldScore: 7,
          safetyScore: 40,
          safetyGrade: "NR",
          yieldToRisk: 0.05,
          excessYield: 0.5,
          yieldStability: 0.9,
          apyVariance30d: 0.2,
          apyMin30d: 3.0,
          apyMax30d: 3.3,
          warningSignals: [],
          altSources: [],
          provenance: {
            sourceKey: "pool-b",
            sourceObservedAt: updatedAt,
            sourceAgeSeconds: 30,
            confidenceTier: "curated",
            selectionMethod: "confidence-weighted",
            selectionReason: "curated canonical source selected by confidence-weighted arbitration",
            sourceSwitch: false,
            previousBestSourceKey: "pool-b",
            usedLegacyHistory: false,
            usedDefaultSafety: false,
            benchmarkRecordDate: "2026-03-12",
            benchmarkIsFallback: false,
            benchmarkFallbackMode: null,
            anomalies: [],
          },
        },
        {
          id: "orphan-coin",
          symbol: "ORPH",
          name: "Orphan Coin",
          currentApy: 9.9,
          apy7d: 9.9,
          apy30d: 9.9,
          apyBase: 9.9,
          apyReward: null,
          yieldSource: "Source C",
          yieldType: "lending-vault",
          dataSource: "defillama",
          sourceTvlUsd: 100_000,
          pharosYieldScore: 99,
          safetyScore: 99,
          safetyGrade: "A+",
          yieldToRisk: 1,
          excessYield: 5,
          yieldStability: 1,
          apyVariance30d: 0,
          apyMin30d: 9.9,
          apyMax30d: 9.9,
          warningSignals: [],
          altSources: [],
          provenance: null,
        },
      ],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 4.2,
      updatedAt,
      provenance: {
        selectionMethod: "confidence-weighted",
        benchmark: {
          rate: 4.25,
          recordDate: "2026-03-12",
          fetchedAt: updatedAt,
          ageSeconds: 30,
          source: "fred",
          isFallback: false,
          fallbackMode: null,
        },
        dlPools: {
          mode: "dex-cache",
          updatedAt,
          ageSeconds: 30,
          poolCount: 10,
          fallbackMode: null,
        },
        safetySnapshot: {
          kind: "ok",
          coverageRatio: 0.5,
          coveredCount: 1,
          trackedCount: 2,
          reason: null,
        },
      },
    }, updatedAt);

    const res = await handleYieldRankings(db);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      rankings: Array<{
        id: string;
        safetyGrade: string;
        safetyScore: number;
        yieldToRisk: number | null;
        pharosYieldScore: number | null;
        provenance: { usedDefaultSafety: boolean } | null;
      }>;
      provenance: {
        safetySnapshot: {
          kind: string;
          coverageRatio: number;
          coveredCount: number;
          trackedCount: number;
          reason: string | null;
        };
      };
      _meta: { ageSeconds: number };
    };
    expect(body.rankings).toHaveLength(3);
    expect(body.rankings.map((row: { id: string }) => row.id)).toEqual(["rated-coin", "orphan-coin", "nr-coin"]);

    const rankedById = new Map(body.rankings.map((row) => [row.id, row]));
    const orphan = rankedById.get("orphan-coin");
    const rated = rankedById.get("rated-coin");
    const unrated = rankedById.get("nr-coin");

    expect(orphan?.safetyGrade).toBe("NR");
    expect(orphan?.safetyScore).toBe(40);
    expect(orphan?.provenance?.usedDefaultSafety).toBeUndefined();

    expect(rated?.safetyGrade).toBe("B-");
    expect(rated?.safetyScore).toBe(66);
    expect(rated?.yieldToRisk).toBeCloseTo(5 / 35);
    expect(rated?.pharosYieldScore).toBe(12);
    expect(rated?.provenance?.usedDefaultSafety).toBe(false);

    expect(unrated?.safetyGrade).toBe("NR");
    expect(unrated?.safetyScore).toBe(40);
    expect(unrated?.provenance?.usedDefaultSafety).toBe(true);

    expect(body.provenance.safetySnapshot).toEqual({
      kind: "ok",
      coverageRatio: 0.5,
      coveredCount: 1,
      trackedCount: 2,
      reason: null,
    });
    expect(body._meta.ageSeconds).toBe(30);
  });

  it("returns 503 when cache is empty", async () => {
    const res = await handleYieldRankings(mockD1());
    expect(res.status).toBe(503);
  });

  it("returns 503 when cached rankings JSON is malformed", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb("{bad json", updatedAt);

    const res = await handleYieldRankings(db);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached yield-rankings payload is malformed",
    });
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps hourly rankings fresh for snapshots that are under one hour old", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 3_500;
    const db = makeCacheDb({
      rankings: [],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 4.2,
      updatedAt,
      provenance: null,
    }, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as { _meta: { ageSeconds: number; status: string } };

    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(body._meta.ageSeconds).toBe(3_500);
    expect(body._meta.status).toBe("fresh");
  });
});
