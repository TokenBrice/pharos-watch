import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { YieldRankingsResponseSchema, type YieldRanking, type YieldRankingsResponse } from "@shared/types/yield";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/yield-methodology";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { makeYieldRanking, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import {
  SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
  buildSourceRiskGoldenFixture,
  getSourceRiskGoldenRow,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";

const computeSafetyScoresSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/safety-scores", () => ({
  computeSafetyScoresSnapshot: computeSafetyScoresSnapshotMock,
}));

import { handleYieldRankings } from "../cache-handlers";

const V748_RANKINGS_UPDATED_AT = 1_778_679_602;
const V9_METHODOLOGY_VERSION = "9.0";
let currentSafetyIdentity: SafetyScoreV9PublicationIdentity | null = null;

function v9Identity(publicationGenerationId: string): SafetyScoreV9PublicationIdentity {
  return {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: V9_METHODOLOGY_VERSION,
    policyId: "safety-score-v9",
    policyDigest: "c".repeat(64),
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId,
  };
}

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
      publicationGenerationId: `yield-${V748_RANKINGS_UPDATED_AT}`,
      publishedRank: 1,
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
  publication: {
    generationId: `yield-${V748_RANKINGS_UPDATED_AT}`,
    updatedAt: V748_RANKINGS_UPDATED_AT,
    cutoffAt: V748_RANKINGS_UPDATED_AT,
    schemaVersion: 1,
    status: "published",
  },
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
  let payload: unknown;
  try {
    payload = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
  } catch {
    const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
    return mockD1([{
      match: "cache",
      rows: [{ key: "yield-rankings", value: jsonValue, updated_at: updatedAt }],
      first: { key: "yield-rankings", value: jsonValue, updated_at: updatedAt },
    }]);
  }
  if (payload && typeof payload === "object" && "rankings" in payload) {
    const response = payload as YieldRankingsResponse;
    const generationId = response.provenance?.safetySnapshot.publicationGenerationId
      ?? `report-cards:v9:${updatedAt}`;
    currentSafetyIdentity = v9Identity(generationId);
    if (response.provenance) {
      response.provenance = {
        ...response.provenance,
        safetySnapshot: {
          ...response.provenance.safetySnapshot,
          safetyScoreIdentity: currentSafetyIdentity,
        },
      };
    }
  }
  const jsonValue = JSON.stringify(payload);
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
    computeSafetyScoresSnapshotMock.mockReset();
    computeSafetyScoresSnapshotMock.mockImplementation(async () => ({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["rated-coin", { score: 66, grade: "B-" }]]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: Math.floor(Date.now() / 1000),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates live safety scores from the report-card snapshot and falls back to NR defaults for missing cards", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb({
      rankings: [
        makeYieldRanking({
          id: "rated-coin", symbol: "RATE", name: "Rated Coin",
          currentApy: 5.3, apy7d: 5.2, apy30d: 5, apyBase: 5,
          yieldSource: "Source A", yieldType: "lending-vault", dataSource: "defillama",
          sourceTvlUsd: 1_000_000, pharosYieldScore: 8, safetyScore: 40, safetyGrade: "NR",
          yieldToRisk: 0.08, excessYield: 1, yieldStability: 0.8,
          apyVariance30d: 0.5, apyMin30d: 4.9, apyMax30d: 5.4,
          provenance: makeYieldProvenance({
            sourceKey: "pool-a", sourceObservedAt: updatedAt, sourceAgeSeconds: 30,
            previousBestSourceKey: "pool-a", usedDefaultSafety: true, benchmarkRecordDate: "2026-03-12",
          }),
        }),
        makeYieldRanking({
          id: "nr-coin", symbol: "NRC", name: "NR Coin",
          currentApy: 3.2, apy7d: 3.2, apy30d: 3.1, apyBase: 3.1,
          yieldSource: "Source B", yieldType: "lending-vault", dataSource: "defillama",
          sourceTvlUsd: 500_000, pharosYieldScore: 7, safetyScore: 40, safetyGrade: "NR",
          yieldToRisk: 0.05, excessYield: 0.5, yieldStability: 0.9,
          apyVariance30d: 0.2, apyMin30d: 3, apyMax30d: 3.3,
          provenance: makeYieldProvenance({
            sourceKey: "pool-b", sourceObservedAt: updatedAt, sourceAgeSeconds: 30,
            previousBestSourceKey: "pool-b", usedDefaultSafety: false, benchmarkRecordDate: "2026-03-12",
          }),
        }),
        makeYieldRanking({
          id: "orphan-coin", symbol: "ORPH", name: "Orphan Coin",
          currentApy: 9.9, apy7d: 9.9, apy30d: 9.9, apyBase: 9.9,
          yieldSource: "Source C", yieldType: "lending-vault", dataSource: "defillama",
          sourceTvlUsd: 100_000, pharosYieldScore: 99, safetyScore: 99, safetyGrade: "A+",
          yieldToRisk: 1, excessYield: 5, yieldStability: 1,
          apyVariance30d: 0, apyMin30d: 9.9, apyMax30d: 9.9, provenance: null,
        }),
      ],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 4.2,
      updatedAt,
      publication: {
        generationId: `yield-${updatedAt}`,
        updatedAt,
        cutoffAt: updatedAt,
        schemaVersion: 1,
        status: "published",
      },
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
          source: "safety-score-v9-publication",
          publicationGenerationId: `report-cards:v9:${updatedAt}`,
          methodologyVersion: V9_METHODOLOGY_VERSION,
          publishedAt: updatedAt,
        },
      },
    }, updatedAt);

    const res = await handleYieldRankings(db);

    const body = await readJsonResponse(res, 200) as YieldRankingsResponse & { _meta: { ageSeconds: number } };
    expect(body.rankings).toHaveLength(3);
    expect(body.rankings.map((row: { id: string }) => row.id)).toEqual(["rated-coin", "nr-coin", "orphan-coin"]);

    const rankedById = new Map(body.rankings.map((row) => [row.id, row]));
    const orphan = rankedById.get("orphan-coin");
    const rated = rankedById.get("rated-coin");
    const unrated = rankedById.get("nr-coin");

    expect(orphan?.safetyGrade).toBe("NR");
    expect(orphan?.safetyScore).toBe(40);
    expect(orphan?.safetyReason).toBe("report-card-score-missing");
    expect(orphan?.provenance?.usedDefaultSafety).toBeUndefined();

    expect(rated?.safetyGrade).toBe("B-");
    expect(rated?.safetyScore).toBe(66);
    expect(rated?.yieldToRisk).toBeCloseTo(5 / 35);
    expect(rated?.pharosYieldScore).toBe(12);
    expect(rated?.provenance?.usedDefaultSafety).toBe(false);
    expect(rated?.provenance?.safetyProvenance).toBe("live-report-card");
    expect(rated?.safetyReason).toBeNull();
    expect(rated?.provenance).toMatchObject({
      calculationMode: "market-api",
      evidenceClass: "curated-observation",
      evidenceCompleteness: 0.5714,
      scoreQualification: "partial",
      scoreQualified: true,
    });

    expect(unrated?.safetyGrade).toBe("NR");
    expect(unrated?.safetyScore).toBe(40);
    expect(unrated?.provenance?.usedDefaultSafety).toBe(true);
    expect(unrated?.provenance?.safetyProvenance).toBe("default-safety");
    expect(unrated?.safetyReason).toBe("report-card-score-missing");
    expect(unrated?.provenance?.safetyReason).toBe("report-card-score-missing");
    expect(unrated?.pharosYieldScore).toBeGreaterThan(0);
    expect(unrated?.provenance).toMatchObject({
      scoreQualification: "estimated",
      scoreQualified: true,
    });

    expect(body.provenance?.safetySnapshot).toMatchObject({
      kind: "ok",
      coverageRatio: 0.5,
      coveredCount: 1,
      trackedCount: 2,
      reason: null,
      source: "safety-score-v9-publication",
      publicationGenerationId: `report-cards:v9:${updatedAt}`,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      coverageRatio: 0.3333,
      coveredCount: 1,
      trackedCount: 3,
      reason: "low-row-safety-coverage",
      source: "safety-score-v9-publication",
      publicationGenerationId: `report-cards:v9:${updatedAt}`,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: expect.any(Number),
    });
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-degraded",
      reasons: ["low-row-safety-coverage"],
    });
    expect(res.headers.get("Warning")).toContain("199");
    expect(body._meta.ageSeconds).toBe(30);
  });

  it("hydrates across compatible compact publication and base-input generations", async () => {
    const hourlyPublishedAt = Math.floor(Date.now() / 1000) - 3_600;
    const hourlyGenerationId = `report-cards:v9:${hourlyPublishedAt}`;
    const payload = {
      ...v748RankingsPayload,
      rankings: [{
        ...v748RankingsPayload.rankings[0],
        id: "rated-coin",
        symbol: "RATE",
        name: "Rated Coin",
        safetyScore: 40,
        safetyGrade: "NR" as const,
      }],
      updatedAt: hourlyPublishedAt,
      provenance: {
        ...v748RankingsPayload.provenance,
        safetySnapshot: {
          kind: "ok" as const,
          coverageRatio: 0.8462,
          coveredCount: 308,
          trackedCount: 364,
          reason: null,
          source: "safety-score-v9-publication" as const,
          publicationGenerationId: hourlyGenerationId,
          methodologyVersion: V9_METHODOLOGY_VERSION,
          publishedAt: hourlyPublishedAt,
        },
      },
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, hourlyPublishedAt);
    const liveGenerationId = `report-cards:v9:${hourlyPublishedAt + 900}`;
    currentSafetyIdentity = {
      ...v9Identity(liveGenerationId),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    };

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;

    expect(body.rankings[0]).toMatchObject({
      id: "rated-coin",
      safetyScore: 66,
      safetyGrade: "B-",
    });
    expect(body.provenance?.safetySnapshot).toMatchObject(payload.provenance.safetySnapshot);
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "ok",
      coverageRatio: 1,
      coveredCount: 1,
      trackedCount: 1,
      reason: null,
      source: "safety-score-v9-publication",
      publicationGenerationId: liveGenerationId,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: expect.any(Number),
    });
    expect(body.provenance?.liveSafetyHydration?.publicationGenerationId).toBe(liveGenerationId);
    expect(body.rankings[0]?.provenance?.safetyScoreIdentity).toEqual(currentSafetyIdentity);
  });

  it("serves the coherent publish-time safety snapshot instead of blanking on a compact identity mismatch", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb(v748RankingsPayload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["usdc-circle", { score: 88, grade: "A" }]]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: {
        ...v9Identity("report-cards:v9:other"),
        evaluationBuildDigest: "c".repeat(64),
      },
      publicationGenerationId: "report-cards:v9:other",
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    // The cached payload's own publish-time values are coherent (one identity
    // per publish); a live identity mismatch must never null them.
    expect(body.rankings[0]).toMatchObject({
      safetyScore: 40,
      safetyGrade: "NR",
      pharosYieldScore: 11,
    });
    expect(body.rankings[0]?.pysNullReason).toBeUndefined();
    expect(body.rankings[0]?.warningSignals).toEqual([]);
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      reason: "safety-identity-mismatch",
      fallback: "publish-time-snapshot",
      source: "safety-score-v9-publication",
    });
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-stale",
      reasons: ["safety-identity-mismatch"],
    });
    expect(res.headers.get("Warning")).toContain("199");
  })

  it("degrades to explicit NR when the mismatched cached payload is older than the stale-coherent window", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - (24 * 3600 + 60);
    const db = makeCacheDb(v748RankingsPayload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["usdc-circle", { score: 88, grade: "A" }]]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: {
        ...v9Identity("report-cards:v9:other"),
        evaluationBuildDigest: "c".repeat(64),
      },
      publicationGenerationId: "report-cards:v9:other",
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    expect(body.rankings[0]).toMatchObject({
      safetyScore: null,
      safetyGrade: "NR",
      safetyReason: "safety-identity-mismatch",
      pharosYieldScore: null,
      pysNullReason: "safety-unrated",
    });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      reason: "safety-identity-mismatch",
      source: "safety-score-v9-publication",
    });
    expect(body.provenance?.liveSafetyHydration?.fallback).toBeUndefined();
  })

  it("serves the publish-time snapshot when live safety hydration throws", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb(v748RankingsPayload, updatedAt);
    computeSafetyScoresSnapshotMock.mockRejectedValueOnce(new Error("D1 unavailable"));

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    expect(body.rankings[0]).toMatchObject({
      safetyScore: 40,
      pharosYieldScore: 11,
    });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      reason: "safety-snapshot-unavailable",
      fallback: "publish-time-snapshot",
    });
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-stale",
      reasons: ["safety-snapshot-unavailable"],
    });
  });

  it("returns 503 when cached rankings lack the publication contract", async () => {
    const { publication: _publication, ...legacyPayload } = v748RankingsPayload;

    const db = makeCacheDb(legacyPayload, V748_RANKINGS_UPDATED_AT);
    const res = await handleYieldRankings(db);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached yield-rankings payload is malformed",
    });
    expect(computeSafetyScoresSnapshotMock).not.toHaveBeenCalled();
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

  it("does not requalify a stale published PYS during live safety hydration", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          pharosYieldScore: null,
          pysNullReason: "source-stale",
          warningSignals: ["data-stale"],
          provenance: {
            ...v748RankingsPayload.rankings[0].provenance,
            sourceFreshness: "stale",
            benchmarkFreshness: "healthy",
            scoreQualified: false,
          },
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;

    expect(body.rankings[0]).toMatchObject({
      pharosYieldScore: null,
      pysNullReason: "source-stale",
      // `opportunity-evidence-missing` is added by the canonical ladder because
      // this legacy row publishes no venue review; the stale PYS stays null.
      warningSignals: ["data-stale", "opportunity-evidence-missing"],
    });
  });

  it("hydrates Royco tranche rows with opportunity-level safety instead of raw underlying safety", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          yieldSource: "Royco Dawn Senior: Rated Coin",
          yieldType: "structured-tranche",
          safetyScore: 50,
          safetyGrade: "C-",
          provenance: {
            ...v748RankingsPayload.rankings[0].provenance,
            sourceKey: "royco-dawn:1:0xabc:senior",
            safetyProvenance: "cached-publish",
          },
          sourceRisk: {
            sourceRiskPenalty: 1.2,
            deploymentPlace: "structured-tranche",
            venueProtocol: "royco-dawn",
            venueChain: "ethereum",
            venueRiskTier: "unknown",
            trancheSide: "senior",
            marketStatus: "normal",
            marketCoverageRatio: 0.36,
            marketMinCoverageRatio: 0.15,
            marketUtilizationRatio: 0.41,
            marketUtilizationLimitRatio: 0.9,
            marketDrawdownRatio: 0,
            trancheTvlUsd: 2_900_000,
            kycRequired: true,
            accessRestricted: true,
            investabilityFlags: ["kyc-required", "us-persons-restricted", "withdrawals-underlying-dependent"],
          },
          altSources: [
            {
              sourceKey: "royco-dawn:1:0xabc:junior",
              yieldSource: "Royco Dawn Junior: Rated Coin",
              yieldType: "structured-tranche",
              currentApy: 12,
              apy30d: 11,
              sourceTvlUsd: 1_500_000,
              dataSource: "protocol-api",
              sourceRisk: {
                sourceRiskPenalty: 1.3,
                deploymentPlace: "structured-tranche",
                venueProtocol: "royco-dawn",
                venueChain: "ethereum",
                venueRiskTier: "unknown",
                trancheSide: "junior",
                marketStatus: "normal",
                marketCoverageRatio: 0.36,
                marketMinCoverageRatio: 0.15,
                marketUtilizationRatio: 0.41,
                marketUtilizationLimitRatio: 0.9,
                marketDrawdownRatio: 0,
                trancheTvlUsd: 1_500_000,
                underlyingSafetyScore: 50,
                trancheSafetyScore: 20,
                trancheSafetyPenalty: 30,
              },
            },
          ],
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row?.safetyScore).toBe(61);
    expect(row?.safetyGrade).toBe("C+");
    expect(row?.provenance?.safetyProvenance).toBe("opportunity-safety");
    expect(row?.provenance?.usedDefaultSafety).toBe(false);
    expect(row?.sourceRisk).toMatchObject({
      underlyingSafetyScore: 66,
      trancheSafetyScore: 61,
      trancheSafetyPenalty: 5,
      trancheSide: "senior",
    });
    expect(row?.altSources[0]?.sourceRisk).toMatchObject({
      underlyingSafetyScore: 66,
      trancheSafetyScore: 37,
      trancheSafetyPenalty: 29,
      trancheSide: "junior",
    });
    expect(row?.pharosYieldScore).toBe(computePYS({
      apy30d: payload.rankings[0].apy30d,
      safetyScore: 61,
      apyVarianceScore: yieldStabilityToApyVarianceScore(payload.rankings[0].yieldStability),
      scalingFactor: payload.scalingFactor,
      benchmarkRate: payload.rankings[0].benchmarkRate ?? null,
      sourceRiskPenalty: 1.2,
    }));
  });

  it("rehydrates generic external opportunities with market-level safety", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          safetyScore: 50,
          safetyGrade: "C-",
          sourceRisk: {
            venueRiskWeighted: 3,
            venueRiskTier: "medium",
            sourceRiskPenalty: 1.1,
            opportunityRisk: {
              opportunityClass: "lending",
              underlyingSafetyScore: 50,
              opportunitySafetyScore: 45,
              opportunitySafetyPenalty: 5,
              venueReviewed: true,
              missingCriticalEvidence: [],
            },
          },
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;

    const res = await handleYieldRankings(makeCacheDb(payload, updatedAt));
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row?.safetyScore).toBe(61);
    expect(row?.safetyGrade).toBe("C+");
    expect(row?.provenance?.safetyProvenance).toBe("opportunity-safety");
    expect(row?.sourceRisk?.opportunityRisk).toMatchObject({
      opportunityClass: "lending",
      underlyingSafetyScore: 66,
      opportunitySafetyScore: 61,
      opportunitySafetyPenalty: 5,
      missingCriticalEvidence: [],
    });
    expect(row?.pharosYieldScore).toBe(computePYS({
      apy30d: payload.rankings[0].apy30d,
      safetyScore: 61,
      apyVarianceScore: yieldStabilityToApyVarianceScore(payload.rankings[0].yieldStability),
      scalingFactor: payload.scalingFactor,
      benchmarkRate: payload.rankings[0].benchmarkRate ?? null,
      sourceRiskPenalty: 1.1,
    }));
  });

  it("keeps an external opportunity estimated when critical market evidence is missing", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          sourceTvlUsd: null,
          pharosYieldScore: null,
          pysNullReason: "opportunity-evidence-missing",
          sourceRisk: {
            venueRiskTier: "unknown",
            opportunityRisk: {
              opportunityClass: "lending",
              underlyingSafetyScore: 50,
              opportunitySafetyScore: null,
              opportunitySafetyPenalty: null,
              venueReviewed: false,
              missingCriticalEvidence: ["venue-review", "market-size"],
            },
          },
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;

    const res = await handleYieldRankings(makeCacheDb(payload, updatedAt));
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row?.pharosYieldScore).toBeGreaterThan(0);
    expect(row?.pysNullReason).toBeNull();
    expect(row?.provenance?.scoreQualification).toBe("estimated");
    expect(row?.warningSignals).toContain("opportunity-evidence-missing");
    expect(row?.warningSignals).not.toContain("safety-unrated");
    expect(row?.sourceRisk?.opportunityRisk).toMatchObject({
      underlyingSafetyScore: 66,
      opportunitySafetyScore: null,
      missingCriticalEvidence: ["venue-review", "market-size"],
    });
  });

  it("preserves the explicit publication contract and nested source risk without row synthesis", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const rewardHeavyRisk = buildSourceRiskGoldenFixture("reward-heavy", {
      sourceRiskScore: 76,
      sourceDepthRatio: 0.12,
      venueRiskTier: "medium",
    });
    const staleSourceRisk = buildSourceRiskGoldenFixture("stale-source-age");
    const {
      publicationGenerationId: _publicationGenerationId,
      publishedRank: _publishedRank,
      ...baseRow
    } = v748RankingsPayload.rankings[0];
    const payload = {
      ...v748RankingsPayload,
      publication: {
        generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
        updatedAt,
        cutoffAt: updatedAt,
        schemaVersion: 1,
        status: "published" as const,
      },
      rankings: [
        {
          ...baseRow,
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          sourceRisk: rewardHeavyRisk,
          altSources: [
            {
              ...v748RankingsPayload.rankings[0].altSources[0],
              sourceRisk: staleSourceRisk,
            },
          ],
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    expect(body.methodology?.version).toBe(YIELD_METHODOLOGY_VERSION);
    expect(body.publication).toMatchObject({
      generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
      status: "published",
      cutoffAt: updatedAt,
    });
    expect(body.rankings[0]).toMatchObject({
      sourceRisk: {
        sourceRiskPenalty: rewardHeavyRisk.sourceRiskPenalty,
        sourceRiskScore: 76,
        sourceDepthRatio: 0.12,
        rewardShare: rewardHeavyRisk.rewardShare,
        venueRiskTier: "medium",
      },
    });
    expect(body.rankings[0]?.publicationGenerationId).toBeUndefined();
    expect(body.rankings[0]?.publishedRank).toBeUndefined();
    expect(body.rankings[0]?.altSources[0]?.sourceRisk).toMatchObject({
      sourceRiskPenalty: staleSourceRisk.sourceRiskPenalty,
      sourceAgeSeconds: staleSourceRisk.sourceAgeSeconds,
      venueRiskTier: "unknown",
    });
  });

  it("does not treat flattened source-risk shorthand as public rankings evidence", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const rewardHeavyRow = getSourceRiskGoldenRow("reward-heavy");
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          sourceRiskPenalty: rewardHeavyRow.expectedDerivedPenalty,
        },
      ],
      updatedAt,
    } as unknown as YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;
    const row = body.rankings[0];

    // The row may only carry derived opportunity evidence — never the flattened
    // row-level shorthand the schema stripped.
    expect(row?.sourceRisk?.sourceRiskPenalty).toBeUndefined();
    expect(Object.keys(row?.sourceRisk ?? {}).sort()).toEqual(["opportunityRisk", "underlyingSafetyScore"]);
    expect(row?.sourceRisk?.opportunityRisk?.opportunitySafetyScore).toBeNull();
    expect((row as unknown as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
    expect(row?.pharosYieldScore).toBe(computePYS({
      apy30d: payload.rankings[0].apy30d,
      safetyScore: 66,
      apyVarianceScore: yieldStabilityToApyVarianceScore(payload.rankings[0].yieldStability),
      scalingFactor: payload.scalingFactor,
      benchmarkRate: payload.rankings[0].benchmarkRate ?? null,
      sourceRiskPenalty: null,
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
    expect(body.rankings[0]?.rankChangeAttribution).toMatchObject({
      previousRank: 2,
      rankDelta: 1,
      previousPys: 8,
      primaryDriver: "stablecoin-safety",
    });
    expect(body.rankings[0]?.rankChangeAttribution?.pysDelta).toBe(
      computePYS({
        apy30d: 5,
        safetyScore: 66,
        apyVarianceScore: yieldStabilityToApyVarianceScore(baseRow.yieldStability),
        scalingFactor: payload.scalingFactor,
        benchmarkRate: baseRow.benchmarkRate ?? null,
        sourceRiskPenalty: null,
      }) - 8,
    );
    expect(body.rankings[0]?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBe(
      body.rankings[0]?.rankChangeAttribution?.pysDelta,
    );
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

  it("propagates decisionLedger through the cache round-trip on the public payload", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          decisionLedger: {
            selectedReasonCode: "curated-over-discovered" as const,
            previousBestSourceKey: "defillama-auto:legacy",
            sourceSwitch: true,
            apy30dDeltaFromPrevious: null,
            rejectedCount: 1,
            alternatives: [
              {
                sourceKey: "defillama-auto:compound-v3:usdc",
                yieldSource: "Compound V3 USDC",
                apy30dDelta: -0.51,
                rejectionReasonCode: "lower-confidence" as const,
              },
            ],
          },
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    expect(body.rankings[0]?.decisionLedger).toEqual({
      selectedReasonCode: "curated-over-discovered",
      previousBestSourceKey: "defillama-auto:legacy",
      sourceSwitch: true,
      apy30dDeltaFromPrevious: null,
      rejectedCount: 1,
      alternatives: [
        {
          sourceKey: "defillama-auto:compound-v3:usdc",
          yieldSource: "Compound V3 USDC",
          apy30dDelta: -0.51,
          rejectionReasonCode: "lower-confidence",
        },
      ],
    });
  });

  it("returns 503 when cache is empty", async () => {
    const res = await handleYieldRankings(mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    ]));
    expect(res.status).toBe(503);
  });

  it.each([
    ["active V9 marker", "active-safety-score:v9"],
    ["malformed V9 marker", "active-safety-score:activation-marker-invalid"],
    ["mismatched V9 identity", "active-safety-score:v9-identity-mismatch"],
  ])("serves the publish-time snapshot with Warning 199 for %s", async (_label, snapshotReason) => {
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
      reason: snapshotReason,
      scores: new Map(),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    });
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb(v748RankingsPayload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse & {
      warnings?: Array<{ code: string; reasons?: string[] }>;
      _meta: { ageSeconds: number };
    };

    expect(res.headers.get("Warning")).toContain("199");
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-stale",
      // C17: the upstream snapshot reason is threaded next to the read path's own.
      reasons: ["safety-snapshot-unavailable", snapshotReason],
    });
    expect(body.rankings).toHaveLength(1);
    expect(body.rankings[0]).toMatchObject({
      id: "usdc-circle",
      currentApy: 4.72,
      safetyScore: 40,
      safetyGrade: "NR",
      pharosYieldScore: 11,
    });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      reason: `safety-snapshot-unavailable,${snapshotReason}`,
      fallback: "publish-time-snapshot",
      // C17: one coverage definition on every path — a publish-time snapshot is
      // not live-report-card safety, so nothing counts as covered here.
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
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
    expect(computeSafetyScoresSnapshotMock).not.toHaveBeenCalled();
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
    expect(computeSafetyScoresSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps post-V9 rankings fresh for snapshots that are under one hour old", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 3_500;
    const db = makeCacheDb({
      rankings: [],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 4.2,
      updatedAt,
      publication: {
        generationId: `yield-${updatedAt}`,
        updatedAt,
        cutoffAt: updatedAt,
        schemaVersion: 1,
        status: "published",
      },
      provenance: null,
    }, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as { _meta: { ageSeconds: number; status: string } };

    expect(res.headers.get("Warning")).toContain("safety-identity-missing");
    expect(body._meta.ageSeconds).toBe(3_500);
    expect(body._meta.status).toBe("fresh");
  });

  it("does not report movement for a tie-group reorder the publisher ranked by PYS alone", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const tieRow = (name: string, publishedRank: number) =>
      makeYieldRanking({
        id: name.toLowerCase().replace(/\s+/g, "-"),
        symbol: name.slice(0, 3).toUpperCase(),
        name,
        currentApy: 4,
        apy7d: 4,
        apy30d: 4,
        apyBase: 4,
        safetyScore: 40,
        safetyGrade: "NR",
        pharosYieldScore: 50,
        publishedRank,
        provenance: makeYieldProvenance({
          sourceKey: `pool-${publishedRank}`,
          sourceObservedAt: updatedAt,
          sourceAgeSeconds: 30,
        }),
      });
    const db = makeCacheDb({
      ...v748RankingsPayload,
      rankings: [tieRow("Charlie Coin", 1), tieRow("Alpha Coin", 2), tieRow("Bravo Coin", 3)],
      updatedAt,
    }, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;

    // Published order was a PYS-only stable sort; the served order is the live
    // comparator (PYS, then APY, then name) — the tie group reorders, and the
    // baseline rank is re-derived with that same comparator.
    expect(body.rankings.map((row) => row.name)).toEqual(["Alpha Coin", "Bravo Coin", "Charlie Coin"]);
    expect(body.rankings.map((row) => row.publishedRank)).toEqual([2, 3, 1]);
    expect(body.rankings.map((row) => row.liveRank)).toEqual([1, 2, 3]);
    expect(body.rankings.map((row) => row.rankChangeAttribution)).toEqual([
      undefined, undefined, undefined,
    ]);
  });

  it("attributes stablecoin-safety only to the row whose own safety changed", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const row = (id: string, name: string, pharosYieldScore: number, publishedRank: number) =>
      makeYieldRanking({
        id,
        symbol: name.slice(0, 3).toUpperCase(),
        name,
        currentApy: 4,
        apy7d: 4,
        apy30d: 4,
        apyBase: 4,
        safetyScore: 40,
        safetyGrade: "NR",
        pharosYieldScore,
        publishedRank,
        provenance: makeYieldProvenance({
          sourceKey: `pool-${id}`,
          sourceObservedAt: updatedAt,
          sourceAgeSeconds: 30,
        }),
      });
    const payload = {
      ...v748RankingsPayload,
      rankings: [row("mover-coin", "Mover Coin", 10, 1), row("stable-coin", "Stable Coin", 30, 2)],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 2,
      trackedCount: 2,
      coverageRatio: 1,
      scores: new Map([
        ["mover-coin", { score: 88, grade: "A" }],
        ["stable-coin", { score: 40, grade: "NR" }],
      ]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const mover = body.rankings.find((entry) => entry.id === "mover-coin");
    const stable = body.rankings.find((entry) => entry.id === "stable-coin");

    // The live card lifts the mover above the stable row; only the mover's own
    // safety differs from publication.
    expect(mover?.rankChangeAttribution).toMatchObject({
      previousRank: 2,
      rankDelta: 1,
      primaryDriver: "stablecoin-safety",
    });
    expect(mover?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBe(
      mover?.rankChangeAttribution?.pysDelta,
    );
    expect(stable?.rankChangeAttribution).toMatchObject({ previousRank: 1, rankDelta: -1 });
    expect(stable?.rankChangeAttribution?.primaryDriver).not.toBe("stablecoin-safety");
    expect(stable?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBeNull();
  });

  it("serves no movement for a payload published under another methodology version", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    // The payload must have been published under an *older* version, so the
    // fixture version is derived from the current constant: the mismatch stays
    // real when the constant moves, and the assertion below fails loudly if the
    // derivation ever lands on the served version.
    const publishedVersion = YIELD_METHODOLOGY_VERSION.replace(/(\d+)$/, (digits) => `${Math.max(0, Number(digits) - 1)}`);
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        { ...v748RankingsPayload.rankings[0], id: "mover-coin", symbol: "MOV", name: "Mover Coin", pharosYieldScore: 10, publishedRank: 1 },
        { ...v748RankingsPayload.rankings[0], id: "stable-coin", symbol: "STA", name: "Stable Coin", pharosYieldScore: 30, publishedRank: 2 },
      ],
      methodology: {
        version: publishedVersion,
        versionLabel: `v${publishedVersion}`,
        currentVersion: publishedVersion,
        currentVersionLabel: `v${publishedVersion}`,
        changelogPath: "/methodology/yield-intelligence",
        asOf: updatedAt,
        isCurrent: false,
      },
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 2,
      trackedCount: 2,
      coverageRatio: 1,
      scores: new Map([
        ["mover-coin", { score: 88, grade: "A" }],
        ["stable-coin", { score: 40, grade: "NR" }],
      ]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const mover = body.rankings.find((entry) => entry.id === "mover-coin");
    const stable = body.rankings.find((entry) => entry.id === "stable-coin");

    // Scores from two methodologies are not comparable, so the read path serves
    // no movement and no driver rather than fabricating a delta from the version
    // bump alone (B7 rollout: this mislabelled tie-group reorders as movements).
    expect(publishedVersion).not.toBe(YIELD_METHODOLOGY_VERSION);
    expect(mover?.rankChangeAttribution ?? null).toBeNull();
    expect(stable?.rankChangeAttribution ?? null).toBeNull();
  });

  it("keeps a non-safety pysNullReason through the degraded safety path", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - (24 * 3600 + 60);
    const payload = {
      ...v748RankingsPayload,
      rankings: [{
        ...v748RankingsPayload.rankings[0],
        id: "stale-coin",
        symbol: "STA",
        name: "Stale Coin",
        pharosYieldScore: null,
        pysNullReason: "source-stale" as const,
        warningSignals: ["data-stale"],
        provenance: {
          ...v748RankingsPayload.rankings[0].provenance,
          sourceFreshness: "stale" as const,
          scoreQualified: false,
        },
      }],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["stale-coin", { score: 88, grade: "A" }]]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: {
        ...v9Identity("report-cards:v9:other"),
        evaluationBuildDigest: "c".repeat(64),
      },
      publicationGenerationId: "report-cards:v9:other",
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await readJsonResponse(res, 200) as YieldRankingsResponse;

    expect(body.rankings[0]).toMatchObject({
      safetyScore: null,
      pharosYieldScore: null,
      // B37: the row's own reason survived; the safety loss did not rewrite it.
      pysNullReason: "source-stale",
      warningSignals: ["data-stale", "safety-unrated"],
    });
    expect(body.provenance?.liveSafetyHydration?.fallback).toBeUndefined();
  });

  it("nulls the served score whenever a null reason is published", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "zero-apy-coin",
          symbol: "ZRO",
          name: "Zero Apy Coin",
          currentApy: 0,
          apy7d: 0,
          apy30d: 0,
          apyBase: 0,
          pharosYieldScore: 0,
        },
        { ...v748RankingsPayload.rankings[0], id: "rated-coin", symbol: "RATE", name: "Rated Coin" },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const zeroApy = body.rankings.find((entry) => entry.id === "zero-apy-coin");

    // B22: the UI's NR gate is `pharosYieldScore === null`, so a hard 0 with a
    // reason nobody renders must not be published.
    expect(zeroApy?.pharosYieldScore).toBeNull();
    expect(zeroApy?.pysNullReason).toBe("apy-non-positive");
  });

  it("reproduces the served score from the served source-risk penalty", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [{
        ...v748RankingsPayload.rankings[0],
        id: "rated-coin",
        symbol: "RATE",
        name: "Rated Coin",
        safetyScore: 50,
        safetyGrade: "C-" as const,
        sourceRisk: {
          sourceRiskPenalty: 1.2,
          venueRiskTier: "medium" as const,
          sourceDepthRatio: 0.12,
        },
      }],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    // B6: the emitted evidence must reproduce the emitted score.
    expect(row?.pharosYieldScore).toBe(computePYS({
      apy30d: payload.rankings[0].apy30d,
      safetyScore: row?.safetyScore ?? 0,
      apyVarianceScore: yieldStabilityToApyVarianceScore(payload.rankings[0].yieldStability),
      scalingFactor: payload.scalingFactor,
      benchmarkRate: payload.rankings[0].benchmarkRate ?? null,
      benchmarkCurrency: payload.rankings[0].benchmarkCurrency ?? null,
      sourceRiskPenalty: row?.sourceRisk?.sourceRiskPenalty ?? null,
    }));
  });

  it("emits an aging signal and downgrades observations past the tightened daily bounds", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const dailyRow = (id: string, name: string, sourceAgeSeconds: number) =>
      makeYieldRanking({
        id,
        symbol: name.slice(0, 3).toUpperCase(),
        name,
        currentApy: 4,
        apy7d: 4,
        apy30d: 4,
        apyBase: 4,
        dataSource: "price-derived",
        safetyScore: 40,
        safetyGrade: "NR",
        yieldSource: "Supply-history NAV appreciation",
        provenance: makeYieldProvenance({
          sourceKey: "price-derived",
          sourceObservedAt: updatedAt - sourceAgeSeconds,
          sourceAgeSeconds,
          // The cached publication stamped both rows fresh under the old bounds.
          sourceFreshness: "fresh" as const,
        }),
      });
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        dailyRow("aging-coin", "Aging Coin", 28 * 3600),
        dailyRow("stale-coin", "Stale Coin", 31 * 3600),
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const aging = body.rankings.find((entry) => entry.id === "aging-coin");
    const stale = body.rankings.find((entry) => entry.id === "stale-coin");

    // B21: price-derived rows go `aging` after 27h and stale after 30h.
    expect(aging?.warningSignals).toContain("aging");
    expect(aging?.warningSignals).not.toContain("data-stale");
    expect(aging?.pharosYieldScore).not.toBeNull();
    expect(stale?.warningSignals).toContain("data-stale");
    expect(stale?.provenance?.sourceFreshness).toBe("stale");
    expect(stale?.pysNullReason).toBe("source-stale");
    expect(stale?.pharosYieldScore).toBeNull();
  });

  it("falls back to the published benchmark warning when the cached provenance carries no benchmark freshness", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          warningSignals: ["benchmark-stale"],
          // The cached publication predates `provenance.benchmarkFreshness`, so
          // only the published warning signal can classify the served benchmark.
          provenance: makeYieldProvenance({
            sourceKey: "pool-a",
            sourceObservedAt: updatedAt,
            sourceAgeSeconds: 30,
            previousBestSourceKey: "pool-a",
            benchmarkRecordDate: "2026-03-12",
          }),
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row).toMatchObject({
      pharosYieldScore: null,
      pysNullReason: "benchmark-stale",
      warningSignals: expect.arrayContaining(["benchmark-stale"]),
      provenance: expect.objectContaining({
        benchmarkFreshness: "stale",
        scoreQualification: "NR",
        scoreQualified: false,
      }),
    });
  });

  it("keeps a benchmark-degraded row scored while recording the degraded freshness", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          warningSignals: ["benchmark-degraded"],
          provenance: makeYieldProvenance({
            sourceKey: "pool-a",
            sourceObservedAt: updatedAt,
            sourceAgeSeconds: 30,
            previousBestSourceKey: "pool-a",
            benchmarkRecordDate: "2026-03-12",
          }),
        },
      ],
      updatedAt,
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, updatedAt);

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(row?.pysNullReason ?? null).toBeNull();
    expect(row?.pharosYieldScore).not.toBeNull();
    expect(row?.provenance?.benchmarkFreshness).toBe("degraded");
    expect(row?.provenance?.scoreQualification).toBe("estimated");
  });

  it("re-bases a non-USD row on the payload's own reference evidence, not the raw rate (A3)", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    // Published while the USD reference was degraded: the write path scored the
    // row with re-base 0 and said so.
    const publishedScore = computePYS({
      apy30d: 3,
      safetyScore: 80,
      apyVarianceScore: yieldStabilityToApyVarianceScore(0.9),
      scalingFactor: 8,
      benchmarkRate: 2.17,
      benchmarkCurrency: "EUR",
      usdBenchmarkRate: null,
      sourceRiskPenalty: null,
    });
    const eurRow = makeYieldRanking({
      id: "eurc-circle",
      symbol: "EURC",
      name: "Euro Coin",
      currentApy: 3,
      apy7d: 3,
      apy30d: 3,
      apyBase: 3,
      apyReward: null,
      yieldSource: "EUR holder vault",
      yieldType: "nav-appreciation",
      dataSource: "protocol-api",
      sourceTvlUsd: 1_000_000,
      safetyScore: 80,
      safetyGrade: "B+",
      yieldStability: 0.9,
      benchmarkKey: "EUR",
      benchmarkLabel: "EUR €STR",
      benchmarkCurrency: "EUR",
      benchmarkRate: 2.17,
      benchmarkSelectionMode: "native",
      pharosYieldScore: publishedScore,
      publishedRank: 1,
      warningSignals: ["reference-benchmark-degraded"],
      provenance: makeYieldProvenance({
        sourceKey: "protocol-api:eurc:vault",
        sourceObservedAt: updatedAt,
        sourceAgeSeconds: 30,
        previousBestSourceKey: "protocol-api:eurc:vault",
        benchmarkKey: "EUR",
        benchmarkLabel: "EUR €STR",
        benchmarkCurrency: "EUR",
        benchmarkRate: 2.17,
        benchmarkSelectionMode: "native",
        benchmarkRecordDate: "2026-03-12",
        scoreQualification: "estimated",
      }),
    });
    const serve = async (usd: NonNullable<YieldRankingsResponse["benchmarks"]>) => {
      const db = makeCacheDb(
        { ...v748RankingsPayload, rankings: [eurRow], benchmarks: usd, updatedAt },
        updatedAt,
      );
      const res = await handleYieldRankings(db);
      return ((await res.json()) as YieldRankingsResponse).rankings[0];
    };
    computeSafetyScoresSnapshotMock.mockImplementation(async () => ({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["eurc-circle", { score: 80, grade: "B+" }]]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    }));

    const degraded = await serve({
      USD: { ...v748RankingsPayload.benchmarks.USD, isFallback: true, fallbackMode: "retained" },
    });
    // Same score the publication served: no re-base, an `estimated` cap that
    // names the reference, and the warning the write path published.
    expect(degraded?.pharosYieldScore).toBe(publishedScore);
    expect(degraded?.provenance?.scoreQualification).toBe("estimated");
    expect(degraded?.warningSignals).toContain("reference-benchmark-degraded");

    const healthy = await serve({ USD: v748RankingsPayload.benchmarks.USD });
    const rebasedScore = computePYS({
      apy30d: 3,
      safetyScore: 80,
      apyVarianceScore: yieldStabilityToApyVarianceScore(0.9),
      scalingFactor: 8,
      benchmarkRate: 2.17,
      benchmarkCurrency: "EUR",
      usdBenchmarkRate: 4.13,
      sourceRiskPenalty: null,
    });
    expect(healthy?.pharosYieldScore).toBe(rebasedScore);
    // The two reference states must actually differ, or the degraded case above
    // could pass by accident.
    expect(rebasedScore).not.toBe(publishedScore);
    expect(healthy?.pharosYieldScore ?? 0).toBeGreaterThan(publishedScore);
    expect(healthy?.provenance?.scoreQualification).toBe("partial");
    expect(healthy?.warningSignals).not.toContain("reference-benchmark-degraded");
  });

  it("leaves an unmeasurable safety contribution null and names the benchmark for a rebased move (B7)", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const anchor = makeYieldRanking({
      id: "rated-coin",
      symbol: "RATE",
      name: "Rated Coin",
      currentApy: 12,
      apy7d: 12,
      apy30d: 12,
      apyBase: 12,
      safetyScore: 80,
      safetyGrade: "A",
      pharosYieldScore: 10,
      publishedRank: 2,
      provenance: makeYieldProvenance({
        sourceKey: "pool-anchor",
        sourceObservedAt: updatedAt,
        sourceAgeSeconds: 30,
      }),
    });
    // Published with a scored PYS, then served with no score at all: there is no
    // published/live pair to measure a safety contribution from.
    const unscoreable = makeYieldRanking({
      ...anchor,
      id: "mover-coin",
      symbol: "MOVE",
      name: "Mover Coin",
      currentApy: 0,
      apy7d: 0,
      apy30d: 0,
      apyBase: 0,
      pharosYieldScore: 40,
      publishedRank: 1,
      provenance: makeYieldProvenance({
        sourceKey: "pool-mover",
        sourceObservedAt: updatedAt,
        sourceAgeSeconds: 30,
      }),
    });
    // A re-based (non-USD benchmark) row that cannot hold its published rank.
    const rebased = makeYieldRanking({
      ...anchor,
      id: "rebased-coin",
      symbol: "REB",
      name: "Rebased Coin",
      currentApy: 3,
      apy7d: 3,
      apy30d: 3,
      apyBase: 3,
      benchmarkKey: "EUR",
      benchmarkLabel: "EUR €STR",
      benchmarkCurrency: "EUR",
      benchmarkRate: 2.17,
      pharosYieldScore: 100,
      publishedRank: 1,
      provenance: makeYieldProvenance({
        sourceKey: "pool-rebased",
        sourceObservedAt: updatedAt,
        sourceAgeSeconds: 30,
        benchmarkKey: "EUR",
        benchmarkCurrency: "EUR",
        benchmarkRate: 2.17,
      }),
    });
    computeSafetyScoresSnapshotMock.mockImplementation(async () => ({
      kind: "ok",
      mode: "map",
      coveredCount: 3,
      trackedCount: 3,
      coverageRatio: 1,
      scores: new Map([
        // The mover's card was graded NR at publication and is rated now.
        ["mover-coin", { score: 88, grade: "A" }],
        ["rated-coin", { score: 80, grade: "A" }],
        ["rebased-coin", { score: 80, grade: "A" }],
      ]),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: V9_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    }));
    const run = async (row: YieldRanking) => {
      const db = makeCacheDb({ ...v748RankingsPayload, rankings: [row, anchor], updatedAt }, updatedAt);
      const res = await handleYieldRankings(db);
      const body = (await res.json()) as YieldRankingsResponse;
      return body.rankings.find((entry) => entry.id === row.id);
    };

    const moved = await run(unscoreable);
    expect(moved?.rankChangeAttribution?.primaryDriver).toBe("stablecoin-safety");
    // B7/F6: a null pys delta has no measurable safety contribution — 0 claimed
    // one the row never had.
    expect(moved?.rankChangeAttribution?.pysDelta).toBeNull();
    expect(moved?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBeNull();

    const rebasedMove = await run(rebased);
    expect(rebasedMove?.rankChangeAttribution?.pysDelta).not.toBeNull();
    expect(rebasedMove?.rankChangeAttribution?.primaryDriver).toBe("benchmark");
    expect(rebasedMove?.rankChangeAttribution?.driverContributions?.benchmark).toBe(
      rebasedMove?.rankChangeAttribution?.rankDelta,
    );
    expect(rebasedMove?.rankChangeAttribution?.driverContributions?.apy).toBeNull();
  });
});
