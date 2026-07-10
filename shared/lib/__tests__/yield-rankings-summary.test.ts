import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { projectYieldRankingsSummary } from "../yield-rankings-summary";
import { YieldRankingSummarySchema, YieldRankingsSummaryResponseSchema } from "@shared/types/yield-summary";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";

const CURRENT_SCALE_RANKING_COUNT = 175;
const RAW_PAYLOAD_BUDGET_BYTES = 220_000;
const GZIP_PAYLOAD_BUDGET_BYTES = 25_000;

function deterministicToken(seed: number, length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let state = (seed + 1) * 2_654_435_761;
  let value = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    value += alphabet[state % alphabet.length];
  }
  return value;
}

function makeDetailedRanking(index: number): YieldRanking {
  const token = deterministicToken(index, 18);
  const sourceKey = `protocol-api:${token}:market-${index}`;
  return {
    id: `stablecoin-${token}`,
    symbol: `Y${index}`,
    name: `Yield Stablecoin ${token}`,
    currentApy: 4.75 + (index % 17) / 10,
    apy7d: 4.6 + (index % 13) / 10,
    apy30d: 4.5 + (index % 11) / 10,
    apyBase: 4.25,
    apyReward: 0.25,
    yieldSource: `Protocol market ${token}`,
    yieldSourceUrl: `https://yield-${token}.example/markets/${index}`,
    yieldType: index % 2 === 0 ? "lending-opportunity" : "lending-vault",
    dataSource: "protocol-api",
    sourceTvlUsd: 10_000_000 + index * 101_003,
    pharosYieldScore: 70 + (index % 25) / 10,
    pysNullReason: null,
    safetyScore: 72 + (index % 9),
    safetyGrade: "B+",
    safetyReason: null,
    yieldToRisk: 0.12,
    excessYield: 0.37 + (index % 7) / 100,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.13,
    benchmarkRecordDate: "2026-07-09",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.91,
    apyVariance30d: 0.09,
    apyMin30d: 4.2,
    apyMax30d: 5.1,
    warningSignals: index % 7 === 0 ? ["limited-history", "yield-divergence"] : [],
    altSources: [0, 1, 2].map((alternate) => ({
      sourceKey: `alternate:${token}:${alternate}`,
      yieldSource: `Alternative venue ${alternate} for ${token}`,
      yieldSourceUrl: `https://alternate-${token}.example/${alternate}`,
      yieldType: "lending-opportunity" as const,
      currentApy: 4.2 + alternate / 10,
      apy30d: 4.1 + alternate / 10,
      sourceTvlUsd: 2_000_000 + alternate * 100_000,
      dataSource: "defillama-auto",
      sourceRisk: {
        sourceRiskScore: 28 + alternate,
        sourceRiskPenalty: 1.12,
        venueProtocol: `Alternative protocol ${token}`,
        venueChain: "Ethereum",
        investabilityFlags: [`detail-only-${token}`],
      },
      sourceRole: "audit-alternate" as const,
      confidenceTier: "discovered" as const,
      calculationMode: "market-api" as const,
      evidenceClass: "discovered-observation" as const,
      evidenceCompleteness: 0.72,
      scoreQualification: "partial" as const,
    })),
    alternateSummary: {
      count: 3,
      bestAlternateByApy: null,
      bestRiskAdjustedAlternate: null,
      alternateApySpread: 0.2,
    },
    provenance: {
      sourceKey,
      sourceObservedAt: 1_783_632_600,
      sourceAgeSeconds: 1_800 + index,
      comparisonAnchorObservedAt: 1_783_628_000,
      comparisonAnchorAgeSeconds: 6_400 + index,
      confidenceTier: "curated",
      calculationMode: "market-api",
      evidenceClass: "direct-first-party",
      evidenceCompleteness: 0.92,
      scoreQualification: "rated",
      selectionMethod: "confidence-weighted",
      selectionReason: `Detailed arbitration reason for ${token}`,
      sourceSwitch: index % 19 === 0,
      previousBestSourceKey: sourceKey,
      usedLegacyHistory: false,
      usedDefaultSafety: false,
      safetyProvenance: "live-report-card",
      safetyReason: null,
      benchmarkKey: "USD",
      benchmarkLabel: "USD 3M T-Bill",
      benchmarkCurrency: "USD",
      benchmarkRate: 4.13,
      benchmarkRecordDate: "2026-07-09",
      benchmarkIsFallback: false,
      benchmarkFallbackMode: null,
      benchmarkSelectionMode: "native",
      benchmarkIsProxy: false,
      sourceFreshness: "fresh",
      benchmarkFreshness: "healthy",
      scoreQualified: true,
      anomalies: [`detail-anomaly-${token}`],
    },
    publicationGenerationId: `yield-generation-${token}`,
    publishedRank: index + 1,
    liveRank: index + 1,
    sourceRisk: {
      sourceRiskScore: 18 + (index % 20),
      sourceRiskPenalty: 1.08,
      sourceDepthRatio: 0.005,
      rewardShare: 0.18,
      sourceAgeSeconds: 1_800 + index,
      observationCount30d: 620 + index,
      sourceSwitchCount30d: index % 3,
      deploymentPlace: "lending-market",
      venueProtocol: `Detailed venue ${token}`,
      venueChain: "Ethereum",
      venueRiskTier: "medium",
      venueRiskWeighted: 2.4,
      venueRiskConfidence: "verified",
      dependencyConcentration: {
        ecosystem: `Dependency ${token}`,
        severity: "medium",
        note: `Detail-only dependency evidence ${token}`,
        reviewedAt: "2026-07-01",
      },
      withdrawalDelaySeconds: 86_400,
      kycRequired: false,
      accessRestricted: false,
      investabilityFlags: [`detail-only-access-${token}`],
    },
    sourceRole: "external-opportunity",
    rankChangeAttribution: {
      previousRank: index + 2,
      rankDelta: 1,
      previousPys: 69.5,
      pysDelta: 0.5,
      primaryDriver: "apy",
      driverContributions: { apy: 0.5, sourceRisk: -0.1 },
    },
    decisionLedger: {
      selectedReasonCode: "curated-over-discovered",
      previousBestSourceKey: sourceKey,
      sourceSwitch: false,
      apy30dDeltaFromPrevious: 0.12,
      rejectedCount: 3,
      alternatives: [
        {
          sourceKey: `rejected:${token}`,
          yieldSource: `Rejected source ${token}`,
          apy30dDelta: -0.3,
          rejectionReasonCode: "lower-confidence",
          confidenceTier: "discovered",
          sourceRole: "audit-alternate",
          selectionRank: 2,
        },
      ],
    },
  };
}

function makeDetailedResponse(count: number): YieldRankingsResponse {
  return {
    rankings: Array.from({ length: count }, (_, index) => makeDetailedRanking(index)),
    riskFreeRate: 4.13,
    benchmarks: {
      USD: {
        key: "USD",
        label: "USD 3M T-Bill",
        currency: "USD",
        rate: 4.13,
        recordDate: "2026-07-09",
        fetchedAt: 1_783_632_600,
        ageSeconds: 1_800,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
        isProxy: false,
      },
    },
    scalingFactor: 8,
    medianApy: 4.9,
    updatedAt: 1_783_632_600,
    publication: {
      generationId: "yield-generation-current",
      updatedAt: 1_783_632_600,
      cutoffAt: 1_783_632_600,
      schemaVersion: 1,
      status: "published",
    },
  };
}

describe("projectYieldRankingsSummary", () => {
  it("emits a strict page projection without detail-only ranking fields", () => {
    const detailed = makeDetailedResponse(1);
    const summary = projectYieldRankingsSummary(detailed);
    const parsed = YieldRankingsSummaryResponseSchema.safeParse(summary);

    expect(parsed.success).toBe(true);
    expect(summary.projection).toBe("summary");
    expect(summary.rankings[0]).toMatchObject({
      id: detailed.rankings[0].id,
      alternateSourceCount: 3,
      provenance: {
        calculationMode: "market-api",
        evidenceClass: "direct-first-party",
        evidenceCompleteness: 0.92,
        scoreQualification: "rated",
      },
      sourceRisk: {
        sourceRiskScore: 18,
        sourceDepthRatio: 0.005,
        venueRiskTier: "medium",
      },
    });
    expect(summary.rankings[0]).not.toHaveProperty("altSources");
    expect(summary.rankings[0]).not.toHaveProperty("alternateSummary");
    expect(summary.rankings[0]).not.toHaveProperty("dataSource");
    expect(summary.rankings[0]).not.toHaveProperty("decisionLedger");
    expect(summary.rankings[0]).not.toHaveProperty("rankChangeAttribution");
    expect(summary.rankings[0].provenance).not.toHaveProperty("selectionReason");
    expect(summary.rankings[0].sourceRisk).not.toHaveProperty("dependencyConcentration");
    expect(summary.rankings[0].sourceRisk).not.toHaveProperty("investabilityFlags");
    expect(detailed.rankings[0].altSources).toHaveLength(3);
  });

  it("rejects detail-field leakage at the row schema boundary", () => {
    const summary = projectYieldRankingsSummary(makeDetailedResponse(1));
    expect(
      YieldRankingSummarySchema.safeParse({
        ...summary.rankings[0],
        altSources: [],
      }).success,
    ).toBe(false);
  });

  it("stays within the current-scale raw and gzip payload budgets", () => {
    const summary = projectYieldRankingsSummary(makeDetailedResponse(CURRENT_SCALE_RANKING_COUNT));
    const json = JSON.stringify(summary);
    const rawBytes = new TextEncoder().encode(json).byteLength;
    const gzipBytes = gzipSync(json, { level: 9 }).byteLength;

    expect(rawBytes).toBeLessThanOrEqual(RAW_PAYLOAD_BUDGET_BYTES);
    expect(gzipBytes).toBeLessThanOrEqual(GZIP_PAYLOAD_BUDGET_BYTES);
  });
});
