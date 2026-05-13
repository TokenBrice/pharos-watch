import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { YieldRankingsResponseSchema, type YieldRankingsResponse } from "@shared/types/yield";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";

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

const V748_RANKINGS_UPDATED_AT = 1_778_679_602;

const v748RankingsPayload = {
  rankings: [
    {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      currentApy: 4.72,
      apy7d: 4.69,
      apy30d: 4.61,
      apyBase: 4.61,
      apyReward: null,
      yieldSource: "Aave V3 USDC",
      yieldSourceUrl: "https://aave.com/",
      yieldType: "lending-opportunity",
      dataSource: "protocol-api",
      sourceTvlUsd: 268_000_000,
      pharosYieldScore: 11,
      safetyScore: 40,
      safetyGrade: "NR",
      yieldToRisk: 0.0756,
      excessYield: 0.48,
      benchmarkKey: "USD",
      benchmarkLabel: "USD 3M T-Bill",
      benchmarkCurrency: "USD",
      benchmarkRate: 4.13,
      benchmarkRecordDate: "2026-05-12",
      benchmarkIsFallback: false,
      benchmarkFallbackMode: null,
      benchmarkSelectionMode: "native",
      benchmarkIsProxy: false,
      yieldStability: 0.94,
      apyVariance30d: 0.06,
      apyMin30d: 4.4,
      apyMax30d: 4.9,
      warningSignals: [],
      altSources: [
        {
          sourceKey: "defillama:auto:compound-v3:usdc",
          yieldSource: "Compound V3 USDC",
          yieldSourceUrl: "https://compound.finance/",
          yieldType: "lending-opportunity",
          currentApy: 4.21,
          apy30d: 4.1,
          sourceTvlUsd: 191_000_000,
          dataSource: "defillama-auto",
        },
      ],
      provenance: {
        sourceKey: "protocol-api:aave-v3:usdc",
        sourceObservedAt: V748_RANKINGS_UPDATED_AT,
        sourceAgeSeconds: 0,
        comparisonAnchorObservedAt: null,
        comparisonAnchorAgeSeconds: null,
        confidenceTier: "curated",
        selectionMethod: "confidence-weighted",
        selectionReason: "curated source selected by confidence-weighted arbitration",
        sourceSwitch: false,
        previousBestSourceKey: "protocol-api:aave-v3:usdc",
        usedLegacyHistory: false,
        usedDefaultSafety: true,
        safetyProvenance: "cached-publish",
        benchmarkKey: "USD",
        benchmarkLabel: "USD 3M T-Bill",
        benchmarkCurrency: "USD",
        benchmarkRate: 4.13,
        benchmarkRecordDate: "2026-05-12",
        benchmarkIsFallback: false,
        benchmarkFallbackMode: null,
        benchmarkSelectionMode: "native",
        benchmarkIsProxy: false,
        anomalies: [],
      },
    },
  ],
  riskFreeRate: 4.13,
  benchmarks: {
    USD: {
      key: "USD",
      label: "USD 3M T-Bill",
      currency: "USD",
      rate: 4.13,
      recordDate: "2026-05-12",
      fetchedAt: V748_RANKINGS_UPDATED_AT,
      ageSeconds: 0,
      source: "fred-dgs3mo",
      isFallback: false,
      fallbackMode: null,
      isProxy: false,
    },
  },
  scalingFactor: 8,
  medianApy: 3.55,
  updatedAt: V748_RANKINGS_UPDATED_AT,
  provenance: {
    selectionMethod: "confidence-weighted",
    benchmark: {
      key: "USD",
      label: "USD 3M T-Bill",
      currency: "USD",
      rate: 4.13,
      recordDate: "2026-05-12",
      fetchedAt: V748_RANKINGS_UPDATED_AT,
      ageSeconds: 0,
      source: "fred-dgs3mo",
      isFallback: false,
      fallbackMode: null,
      isProxy: false,
    },
    benchmarks: {
      USD: {
        key: "USD",
        label: "USD 3M T-Bill",
        currency: "USD",
        rate: 4.13,
        recordDate: "2026-05-12",
        fetchedAt: V748_RANKINGS_UPDATED_AT,
        ageSeconds: 0,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
        isProxy: false,
      },
    },
    dlPools: {
      mode: "dex-cache",
      updatedAt: V748_RANKINGS_UPDATED_AT - 240,
      ageSeconds: 240,
      poolCount: 842,
      fallbackMode: null,
    },
    safetySnapshot: {
      kind: "degraded",
      coverageRatio: 0.8464,
      coveredCount: 109,
      trackedCount: 129,
      reason: null,
    },
  },
} satisfies YieldRankingsResponse;

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
        provenance: { usedDefaultSafety: boolean; safetyProvenance?: string } | null;
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
      warnings?: Array<{ code: string; reasons?: string[] }>;
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
    expect(rated?.provenance?.safetyProvenance).toBe("live-report-card");

    expect(unrated?.safetyGrade).toBe("NR");
    expect(unrated?.safetyScore).toBe(40);
    expect(unrated?.provenance?.usedDefaultSafety).toBe(true);
    expect(unrated?.provenance?.safetyProvenance).toBe("default-safety");

    expect(body.provenance.safetySnapshot).toEqual({
      kind: "ok",
      coverageRatio: 0.3333,
      coveredCount: 1,
      trackedCount: 3,
      reason: "low-row-safety-coverage",
    });
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-degraded",
      reasons: ["low-row-safety-coverage"],
    });
    expect(res.headers.get("Warning")).toContain("199");
    expect(body._meta.ageSeconds).toBe(30);
  });

  it("parses a production-shaped v7.48 old rankings payload through the schema and handler", async () => {
    expect(YieldRankingsResponseSchema.parse(v748RankingsPayload).rankings[0]?.publishedRank).toBeUndefined();

    const db = makeCacheDb(v748RankingsPayload, V748_RANKINGS_UPDATED_AT);
    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse & { _meta: { ageSeconds: number } };

    expect(res.status).toBe(200);
    expect(body.rankings).toHaveLength(1);
    expect(body.rankings[0]?.publishedRank).toBeUndefined();
    expect(body.rankings[0]?.sourceRisk).toBeUndefined();
    expect(body.publication).toBeUndefined();
  });

  it("uses nested sourceRiskPenalty when live safety hydration recomputes PYS", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          sourceRisk: {
            sourceRiskPenalty: 2,
          },
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row?.safetyScore).toBe(66);
    expect(row?.sourceRisk?.sourceRiskPenalty).toBe(2);
    expect(row?.pharosYieldScore).toBe(computePYS({
      apy30d: payload.rankings[0].apy30d,
      safetyScore: 66,
      apyVarianceScore: yieldStabilityToApyVarianceScore(payload.rankings[0].yieldStability),
      scalingFactor: payload.scalingFactor,
      benchmarkRate: payload.rankings[0].benchmarkRate ?? null,
      sourceRiskPenalty: 2,
    }));
  });

  it("preserves publishedRank and assigns liveRank after safety hydration reorders rows", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const baseRow = v748RankingsPayload.rankings[0];
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...baseRow,
          id: "nr-coin",
          symbol: "NRC",
          name: "NR Coin",
          currentApy: 10,
          apy7d: 10,
          apy30d: 10,
          pharosYieldScore: 15,
          publishedRank: 1,
        },
        {
          ...baseRow,
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          currentApy: 5,
          apy7d: 5,
          apy30d: 5,
          pharosYieldScore: 8,
          publishedRank: 2,
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;

    expect(body.rankings.map((row) => row.id)).toEqual(["rated-coin", "nr-coin"]);
    expect(body.rankings[0]).toMatchObject({ id: "rated-coin", publishedRank: 2, liveRank: 1 });
    expect(body.rankings[1]).toMatchObject({ id: "nr-coin", publishedRank: 1, liveRank: 2 });
  });

  it("accepts nullable optional publication, source-risk, rank, and attribution scaffolding", () => {
    const parsed = YieldRankingsResponseSchema.parse({
      ...v748RankingsPayload,
      publication: {
        generationId: null,
        updatedAt: null,
        cutoffAt: null,
        schemaVersion: null,
        status: null,
      },
      rankings: v748RankingsPayload.rankings.map((row) => ({
        ...row,
        publicationGenerationId: null,
        publishedRank: null,
        liveRank: 1,
        sourceRisk: {
          sourceRiskScore: null,
          sourceRiskPenalty: null,
          sourceDepthRatio: null,
          rewardShare: null,
          sourceAgeSeconds: null,
          observationCount30d: null,
          sourceSwitchCount30d: null,
          deploymentPlace: null,
          venueProtocol: null,
          venueChain: null,
          venueRiskTier: "unknown",
          investabilityFlags: [],
        },
        rankChangeAttribution: {
          previousRank: null,
          rankDelta: null,
          previousPys: null,
          pysDelta: null,
          primaryDriver: null,
          driverContributions: {
            apy: null,
            sourceRisk: null,
          },
        },
        altSources: row.altSources.map((alt) => ({
          ...alt,
          sourceRisk: {
            sourceRiskScore: null,
            sourceRiskPenalty: null,
            observationCount30d: null,
            sourceSwitchCount30d: null,
            venueRiskTier: null,
          },
        })),
      })),
    });

    expect(parsed.publication?.generationId).toBeNull();
    expect(parsed.rankings[0]?.liveRank).toBe(1);
    expect(parsed.rankings[0]?.sourceRisk?.venueRiskTier).toBe("unknown");
    expect(parsed.rankings[0]?.rankChangeAttribution?.driverContributions?.sourceRisk).toBeNull();
    expect(parsed.rankings[0]?.altSources[0]?.sourceRisk?.sourceRiskPenalty).toBeNull();
  });

  it("returns 503 when cache is empty", async () => {
    const res = await handleYieldRankings(mockD1());
    expect(res.status).toBe(503);
  });

  it("keeps cached safety fields and emits Warning 199 when live safety hydration fails", async () => {
    buildReportCardsSnapshotMock.mockRejectedValueOnce(new Error("report cards unavailable"));
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb({
      rankings: [],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 4.2,
      updatedAt,
      provenance: null,
    }, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as {
      warnings?: Array<{ code: string; reasons?: string[] }>;
      _meta: { ageSeconds: number };
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toContain("199");
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-degraded",
      reasons: ["live-report-card-hydration-failed"],
    });
    expect(body._meta.ageSeconds).toBe(30);
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

  it("returns 503 when cached rankings JSON fails schema validation", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb({
      rankings: "not-an-array",
      updatedAt,
    }, updatedAt);

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
