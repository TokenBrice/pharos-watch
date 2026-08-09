import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { projectYieldRankingsSummary } from "../yield-rankings-summary";
import {
  YieldRankingSummaryProvenanceSchema,
  YieldRankingSummarySchema,
  YieldRankingSummarySourceRiskSchema,
  YieldRankingsSummaryResponseSchema,
} from "@shared/types/yield-summary";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";

const CURRENT_SCALE_RANKING_COUNT = 175;
// Explicit per-row sourceFreshness adds 4,550 raw bytes at this scale but only
// 39 gzip bytes; retain equivalent raw headroom while the gzip transfer guard stays fixed.
const RAW_PAYLOAD_BUDGET_BYTES = 225_000;
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
      decisionReasonCode: "curated-over-discovered",
      rankDelta: 1,
      rankChangeDriver: "apy",
      rankPysDelta: 0.5,
      provenance: {
        sourceKey: detailed.rankings[0].provenance?.sourceKey,
        calculationMode: "market-api",
        evidenceClass: "direct-first-party",
        evidenceCompleteness: 0.92,
        scoreQualification: "rated",
        sourceFreshness: "fresh",
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

  // The projection copies fields off the summary schemas' own `.shape` keys rather
  // than restating them. These frozen lists pin the emitted wire shape AND its key
  // order, so a schema reorder or an accidentally added/removed field is visible
  // here instead of silently changing the published payload bytes.
  const EXPECTED_ROW_KEYS = [
    "id",
    "symbol",
    "name",
    "currentApy",
    "apy30d",
    "yieldSource",
    "yieldSourceUrl",
    "yieldType",
    "sourceTvlUsd",
    "pharosYieldScore",
    "pysNullReason",
    "safetyScore",
    "safetyGrade",
    "benchmarkKey",
    "benchmarkLabel",
    "benchmarkRate",
    "benchmarkIsFallback",
    "yieldStability",
    "apyMin30d",
    "apyMax30d",
    "warningSignals",
    "alternateSourceCount",
    "decisionReasonCode",
    "rankDelta",
    "rankChangeDriver",
    "rankPysDelta",
    "provenance",
    "sourceRisk",
  ];
  const EXPECTED_PROVENANCE_KEYS = [
    "sourceKey",
    "confidenceTier",
    "calculationMode",
    "evidenceClass",
    "evidenceCompleteness",
    "scoreQualification",
    "sourceFreshness",
    "sourceSwitch",
    "usedDefaultSafety",
    "safetyProvenance",
  ];
  const EXPECTED_SOURCE_RISK_KEYS = [
    "sourceRiskScore",
    "sourceRiskPenalty",
    "sourceDepthRatio",
    "rewardShare",
    "sourceAgeSeconds",
    "observationCount30d",
    "sourceSwitchCount30d",
    "venueRiskTier",
    "venueRiskWeighted",
    "venueRiskConfidence",
  ];

  it("emits exactly the summary schema fields, in schema declaration order", () => {
    const row = projectYieldRankingsSummary(makeDetailedResponse(1)).rankings[0];

    expect(Object.keys(row)).toEqual(EXPECTED_ROW_KEYS);
    expect(Object.keys(row.provenance ?? {})).toEqual(EXPECTED_PROVENANCE_KEYS);
    expect(Object.keys(row.sourceRisk ?? {})).toEqual(EXPECTED_SOURCE_RISK_KEYS);
    // The runtime copy lists are the schemas' own shapes — proving that here means
    // the frozen lists above pin the schema and the projection at the same time.
    expect(Object.keys(YieldRankingSummarySchema.shape)).toEqual(EXPECTED_ROW_KEYS);
    expect(Object.keys(YieldRankingSummaryProvenanceSchema.shape)).toEqual(EXPECTED_PROVENANCE_KEYS);
    expect(Object.keys(YieldRankingSummarySourceRiskSchema.shape)).toEqual(EXPECTED_SOURCE_RISK_KEYS);
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
