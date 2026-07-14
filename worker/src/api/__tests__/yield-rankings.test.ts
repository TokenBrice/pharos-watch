import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { YieldRankingsResponseSchema, type YieldRankingsResponse } from "@shared/types/yield";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/yield-methodology-version";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { SafetyScoreV8PublicationIdentity } from "@shared/types/safety-score-publication";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import {
  SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
  buildSourceRiskGoldenFixture,
  getSourceRiskGoldenRow,
} from "@shared/lib/__tests__/yield-source-risk-golden-fixtures";

const computeSafetyScoresSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/safety-scores", () => ({
  computeSafetyScoresSnapshot: computeSafetyScoresSnapshotMock,
}));

import { handleYieldRankings } from "../cache-handlers";

const V748_RANKINGS_UPDATED_AT = 1_778_679_602;
let currentSafetyIdentity: SafetyScoreV8PublicationIdentity | null = null;

function v8Identity(publicationGenerationId: string): SafetyScoreV8PublicationIdentity {
  return {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
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
      ?? `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    currentSafetyIdentity = v8Identity(generationId);
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
      source: "report-card-cache",
      safetyScoreIdentity: currentSafetyIdentity,
      publicationGenerationId: currentSafetyIdentity?.publicationGenerationId ?? null,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
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
          source: "report-card-cache",
          publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          publishedAt: updatedAt,
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
        safetyReason?: string | null;
        yieldToRisk: number | null;
        pharosYieldScore: number | null;
        provenance: {
          usedDefaultSafety: boolean;
          safetyProvenance?: string;
          safetyReason?: string | null;
          calculationMode?: string;
          evidenceClass?: string;
          evidenceCompleteness?: number;
          scoreQualification?: string;
          scoreQualified?: boolean;
        } | null;
      }>;
      provenance: {
        safetySnapshot: {
          kind: string;
          coverageRatio: number;
          coveredCount: number;
          trackedCount: number;
          reason: string | null;
          source?: string;
          publicationGenerationId?: string | null;
          methodologyVersion?: string | null;
          publishedAt?: number | null;
        };
        liveSafetyHydration?: {
          kind: string;
          coverageRatio: number;
          coveredCount: number;
          trackedCount: number;
          reason: string | null;
          source: string;
          publicationGenerationId: string | null;
          methodologyVersion: string | null;
          publishedAt: number | null;
        };
      };
      warnings?: Array<{ code: string; reasons?: string[] }>;
      _meta: { ageSeconds: number };
    };
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

    expect(body.provenance.safetySnapshot).toMatchObject({
      kind: "ok",
      coverageRatio: 0.5,
      coveredCount: 1,
      trackedCount: 2,
      reason: null,
      source: "report-card-cache",
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });
    expect(body.provenance.liveSafetyHydration).toMatchObject({
      kind: "degraded",
      coverageRatio: 0.3333,
      coveredCount: 1,
      trackedCount: 3,
      reason: "low-row-safety-coverage",
      source: "report-card-cache",
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: expect.any(Number),
    });
    expect(body.warnings?.[0]).toMatchObject({
      code: "yield-safety-hydration-degraded",
      reasons: ["low-row-safety-coverage"],
    });
    expect(res.headers.get("Warning")).toContain("199");
    expect(body._meta.ageSeconds).toBe(30);
  });

  it("hydrates only from the matching compact publication identity", async () => {
    const hourlyPublishedAt = Math.floor(Date.now() / 1000) - 3_600;
    const hourlyGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${hourlyPublishedAt}`;
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
          source: "report-card-cache" as const,
          publicationGenerationId: hourlyGenerationId,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          publishedAt: hourlyPublishedAt,
        },
      },
    } satisfies YieldRankingsResponse;
    const db = makeCacheDb(payload, hourlyPublishedAt);

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
      source: "report-card-cache",
      publicationGenerationId: hourlyGenerationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: expect.any(Number),
    });
    expect(body.provenance?.liveSafetyHydration?.publicationGenerationId).toBe(hourlyGenerationId);
  });

  it("returns explicit NR fields instead of crossing compact safety identities", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeCacheDb(v748RankingsPayload, updatedAt);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map([["usdc-circle", { score: 88, grade: "A" }]]),
      source: "report-card-cache",
      safetyScoreIdentity: v8Identity(`report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:other`),
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:other`,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
    });

    const res = await handleYieldRankings(db);
    const body = await res.json() as YieldRankingsResponse;

    expect(res.status).toBe(200);
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
      source: "report-card-cache",
    });
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
    expect(body.methodology?.version).toBe(YIELD_METHODOLOGY_VERSION);
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
      warningSignals: ["data-stale"],
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

  it("synthesizes publication metadata from generation-aware rows and preserves nested source risk", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const rewardHeavyRisk = buildSourceRiskGoldenFixture("reward-heavy", {
      sourceRiskScore: 76,
      sourceDepthRatio: 0.12,
      venueRiskTier: "medium",
    });
    const staleSourceRisk = buildSourceRiskGoldenFixture("stale-source-age");
    const payload = {
      ...v748RankingsPayload,
      rankings: [
        {
          ...v748RankingsPayload.rankings[0],
          id: "rated-coin",
          symbol: "RATE",
          name: "Rated Coin",
          publicationGenerationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
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
    const body = await res.json() as YieldRankingsResponse;

    expect(res.status).toBe(200);
    expect(body.methodology?.version).toBe(YIELD_METHODOLOGY_VERSION);
    expect(body.publication).toMatchObject({
      generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
      status: "published",
      cutoffAt: updatedAt,
    });
    expect(body.rankings[0]).toMatchObject({
      publicationGenerationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
      publishedRank: 1,
      sourceRisk: {
        sourceRiskPenalty: rewardHeavyRisk.sourceRiskPenalty,
        sourceRiskScore: 76,
        sourceDepthRatio: 0.12,
        rewardShare: rewardHeavyRisk.rewardShare,
        venueRiskTier: "medium",
      },
    });
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
    const body = await res.json() as YieldRankingsResponse;
    const row = body.rankings[0];

    expect(res.status).toBe(200);
    expect(row?.sourceRisk).toBeUndefined();
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
    const body = await res.json() as YieldRankingsResponse;

    expect(res.status).toBe(200);
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
    const res = await handleYieldRankings(mockD1());
    expect(res.status).toBe(503);
  });

  it("returns explicit NR safety and Warning 199 when the compact safety snapshot is unavailable", async () => {
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
      reason: "report-card-cache:missing-cache",
      scores: new Map(),
      source: "report-card-cache",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    });
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
      reasons: ["safety-snapshot-unavailable"],
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
    expect(res.headers.get("Warning")).toContain("safety-identity-missing");
    expect(body._meta.ageSeconds).toBe(3_500);
    expect(body._meta.status).toBe("fresh");
  });
});
