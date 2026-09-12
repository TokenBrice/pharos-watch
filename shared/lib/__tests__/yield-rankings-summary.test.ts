import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { projectYieldRankingsSummary } from "../yield-rankings-summary";
import {
  YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT,
  YieldRankingSummaryAltSourceSchema,
  YieldRankingSummaryProvenanceSchema,
  YieldRankingSummarySchema,
  YieldRankingSummarySourceRiskSchema,
  YieldRankingsSummaryResponseSchema,
} from "@shared/types/yield-summary";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";

const CURRENT_SCALE_RANKING_COUNT = 175;

// Budget calibration, gzip level 9, 2026-09-12 captures.
//
// Recorded production sample: the live *detail* payload (156 rows, the only
// capture that already carries the B36 fields) re-projected through this module
// measured 237,654 raw / 30,524 gzip = 1,523 raw B/row and 195.7 gzip B/row. The
// live pre-B36 summary was 205,414 raw / 23,787 gzip at 157 rows, so B36 grew the
// transfer about 28%; these budgets follow the post-B36 shape. Scaling the sample
// to the 175-row current scale with 10% headroom gives the guard lines below.
//
// The fixture reuses one captured row's shape, so at 175 rows it measures
// 275,589 raw (1,575 B/row, within 4% of the live sample) but only 18,517 gzip
// (105.8 B/row): 175 copies of one shape repeat their literals, and repetition is
// free for zlib but not for the wire. The guard is therefore anchored to the
// recorded production sample — a fixture-anchored gzip budget would repeat the
// defect this test was fixed for, passing while production is over budget — and
// the per-row line is the tightest of the three: an unbounded per-row projection
// fails it long before the totals move.
const PRODUCTION_SAMPLE_ROWS = 156;
const PRODUCTION_SAMPLE_RAW_BYTES = 237_654;
const PRODUCTION_SAMPLE_GZIP_BYTES = 30_524;
const PAYLOAD_BUDGET_HEADROOM = 1.1;

const RAW_PAYLOAD_BUDGET_BYTES = Math.round(
  (PRODUCTION_SAMPLE_RAW_BYTES / PRODUCTION_SAMPLE_ROWS) * CURRENT_SCALE_RANKING_COUNT * PAYLOAD_BUDGET_HEADROOM,
);
const GZIP_PAYLOAD_BUDGET_BYTES = Math.round(
  (PRODUCTION_SAMPLE_GZIP_BYTES / PRODUCTION_SAMPLE_ROWS) * CURRENT_SCALE_RANKING_COUNT * PAYLOAD_BUDGET_HEADROOM,
);
const GZIP_BYTES_PER_ROW_BUDGET = Math.round(
  (PRODUCTION_SAMPLE_GZIP_BYTES / PRODUCTION_SAMPLE_ROWS) * PAYLOAD_BUDGET_HEADROOM,
);

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

/** Production float shape: full double precision, never truncated to 2 decimals. */
const PRODUCTION_FLOAT_STEP = 0.000137481;

/** Production distribution: 113 alternates over 156 rows (77 rows carry at least one). */
const ALT_SOURCES_PER_ROW_ROTATION = [1, 0, 2, 0] as const;

function makeDetailedRanking(index: number): YieldRanking {
  const token = deterministicToken(index, 18);
  const sourceKey = `protocol-api:${token}`;
  return {
    id: `${token.slice(0, 14)}`,
    symbol: `Y${index}`,
    name: `${token.slice(0, 12)} USD`,
    currentApy: 4.168984149295762 + index * PRODUCTION_FLOAT_STEP,
    apy7d: 4.890465987734879 + index * PRODUCTION_FLOAT_STEP,
    apy30d: 4.727776364047721 + index * PRODUCTION_FLOAT_STEP,
    apyBase: 4.168984149295762 + index * PRODUCTION_FLOAT_STEP,
    apyReward: 0.25,
    yieldSource: `Compound V3 (${token.slice(0, 8)})`,
    yieldSourceUrl: `https://app.example/${token.slice(0, 10)}`,
    yieldType: index % 2 === 0 ? "lending-opportunity" : "lending-vault",
    dataSource: index % 2 === 0 ? "protocol-api" : "defillama-auto",
    sourceTvlUsd: 378_956_948.068155 + index * 101_003.51,
    pharosYieldScore: 70 + (index % 25) / 10,
    pysNullReason: null,
    safetyScore: 72 + (index % 9),
    safetyGrade: "B+",
    safetyReason: null,
    yieldToRisk: 0.42979785127706555,
    excessYield: 0.7777763640477211,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 3.95,
    benchmarkRecordDate: "2026-09-09",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.68,
    apyVariance30d: 1.5340915153243797,
    apyMin30d: 3.201113476304074 + index * 0.000113,
    apyMax30d: 11.54427013697823 + index * 0.000191,
    warningSignals: index % 7 === 0 ? ["limited-history", "yield-divergence"] : [],
    altSources: Array.from(
      { length: ALT_SOURCES_PER_ROW_ROTATION[index % ALT_SOURCES_PER_ROW_ROTATION.length] },
      (_, alternate) => ({
        sourceKey: `linked-variant:${token}-${alternate}:onchain`,
        yieldSource: `Maple Finance lending ${alternate}`,
        yieldSourceUrl: `https://app.example/${token.slice(0, 10)}`,
        yieldType: "lending-opportunity" as const,
        currentApy: 4.968675194175987 + (index + alternate) * PRODUCTION_FLOAT_STEP,
        apy30d: 4.922591783613561 + (index + alternate) * PRODUCTION_FLOAT_STEP,
        sourceTvlUsd: 2_654_149_397 + alternate * 1_918_273,
        dataSource: alternate === 0 ? "defillama-auto" : alternate === 1 ? "linked-variant" : "onchain",
        sourceRisk: {
          sourceRiskScore: 28 + alternate,
          sourceRiskPenalty: 1.4124999999999999,
          venueProtocol: `Alternative protocol ${alternate}`,
          venueChain: "Ethereum",
          investabilityFlags: [`detail-only-${token}`],
        },
        sourceRole: "audit-alternate" as const,
        confidenceTier: "discovered" as const,
        calculationMode: "market-api" as const,
        evidenceClass: "discovered-observation" as const,
        evidenceCompleteness: 0.72,
        scoreQualification: "partial" as const,
        selectionRank: alternate + 2,
        rejectionReasonCode: "unspecified" as const,
      }),
    ),
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
      benchmarkRate: 3.95,
      benchmarkRecordDate: "2026-09-09",
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
      sourceDepthRatio: 0.0356230390115429,
      rewardShare: 0.08443698234377667,
      sourceAgeSeconds: 1_800 + index,
      observationCount30d: 620 + index,
      sourceSwitchCount30d: index % 3,
      deploymentPlace: "lending-market",
      venueProtocol: `Detailed venue ${token}`,
      venueChain: "Ethereum",
      venueRiskTier: "medium",
      venueRiskWeighted: 2.7499999999999996,
      venueRiskConfidence: "verified",
      dependencyConcentration: index % 19 === 0
        ? {
          ecosystem: `Dependency ${token}`,
          severity: "medium",
          note: `Detail-only dependency evidence ${token}`,
          reviewedAt: "2026-07-01",
        }
        : null,
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

function makeAltSourceHeavyRanking(index: number): YieldRanking {
  const row = makeDetailedRanking(index);
  return {
    ...row,
    altSources: Array.from({ length: YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT + 3 }, (_, alternate) => ({
      ...row.altSources[alternate % row.altSources.length],
      sourceKey: `${row.altSources[0].sourceKey}:extra-${alternate}`,
      selectionRank: alternate + 2,
    })),
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
      // B36: the lane and role travel with the row instead of being re-derived on
      // the client from `calculationMode` + `confidenceTier` (which disagreed with
      // the detail payload on 46/157 live rows).
      dataSource: "protocol-api",
      sourceRole: "external-opportunity",
      alternateSourceCount: 1,
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
        sourceDepthRatio: 0.0356230390115429,
        venueRiskTier: "medium",
        dependencyConcentration: {
          ecosystem: `Dependency ${deterministicToken(0, 18)}`,
          severity: "medium",
        },
      },
    });
    // `Y1` (index 1) carries exactly one alternate in the fixture.
    expect(summary.rankings[0].altSources).toEqual([
      {
        sourceKey: detailed.rankings[0].altSources[0].sourceKey,
        dataSource: "defillama-auto",
        confidenceTier: "discovered",
        currentApy: detailed.rankings[0].altSources[0].currentApy,
        sourceTvlUsd: 2_654_149_397,
      },
    ]);
    expect(summary.rankings[0]).not.toHaveProperty("alternateSummary");
    expect(summary.rankings[0]).not.toHaveProperty("decisionLedger");
    expect(summary.rankings[0]).not.toHaveProperty("rankChangeAttribution");
    expect(summary.rankings[0].provenance).not.toHaveProperty("selectionReason");
    expect(summary.rankings[0].sourceRisk).not.toHaveProperty("investabilityFlags");
    expect(summary.rankings[0].altSources?.[0]).not.toHaveProperty("sourceRisk");
    expect(summary.rankings[0].altSources?.[0]).not.toHaveProperty("rejectionReasonCode");
  });

  it("keeps alternate rails bounded while the count stays truthful", () => {
    const detailed = makeDetailedResponse(1);
    detailed.rankings[0] = makeAltSourceHeavyRanking(0);
    const summary = projectYieldRankingsSummary(detailed);

    expect(detailed.rankings[0].altSources).toHaveLength(YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT + 3);
    expect(summary.rankings[0].alternateSourceCount).toBe(YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT + 3);
    expect(summary.rankings[0].altSources).toHaveLength(YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT);
    expect(YieldRankingsSummaryResponseSchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
  });

  it.each([
    ["fallback-usd", false, true],
    ["native", true, true],
    ["native", false, undefined],
  ] as const)("serializes benchmark fallback for %s with explicit flag %s", (mode, flag, expected) => {
    const detailed = makeDetailedResponse(1);
    detailed.rankings[0].benchmarkSelectionMode = mode;
    detailed.rankings[0].benchmarkIsFallback = flag;
    const wire = JSON.parse(JSON.stringify(projectYieldRankingsSummary(detailed)));
    if (expected === undefined) {
      expect(wire.rankings[0]).not.toHaveProperty("benchmarkIsFallback");
    } else {
      expect(wire.rankings[0].benchmarkIsFallback).toBe(true);
    }
  });

  it.each([null, undefined])("preserves sparse metadata without invention: %s", (metadata) => {
    const detailed = makeDetailedResponse(1);
    detailed.rankings[0].provenance = metadata;
    detailed.rankings[0].sourceRisk = metadata;
    const summary = projectYieldRankingsSummary(detailed);
    expect(summary.rankings[0].provenance).toBe(metadata);
    expect(summary.rankings[0].sourceRisk).toBe(metadata);
    const wire = JSON.parse(JSON.stringify(summary));
    expect(YieldRankingsSummaryResponseSchema.safeParse(wire).success).toBe(true);
    for (const field of ["provenance", "sourceRisk"]) {
      if (metadata === undefined) expect(wire.rankings[0]).not.toHaveProperty(field);
      else expect(wire.rankings[0][field]).toBeNull();
    }
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
    "dataSource",
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
    "sourceRole",
    "alternateSourceCount",
    "altSources",
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
    "safetyReason",
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
    "dependencyConcentration",
  ];
  const EXPECTED_ALT_SOURCE_KEYS = [
    "sourceKey",
    "dataSource",
    "confidenceTier",
    "currentApy",
    "sourceTvlUsd",
  ];

  it("emits exactly the summary schema fields, in schema declaration order", () => {
    const row = projectYieldRankingsSummary(makeDetailedResponse(1)).rankings[0];

    expect(Object.keys(row)).toEqual(EXPECTED_ROW_KEYS);
    expect(Object.keys(row.provenance ?? {})).toEqual(EXPECTED_PROVENANCE_KEYS);
    expect(Object.keys(row.sourceRisk ?? {})).toEqual(EXPECTED_SOURCE_RISK_KEYS);
    expect(Object.keys(row.altSources?.[0] ?? {})).toEqual(EXPECTED_ALT_SOURCE_KEYS);
    // The runtime copy lists are the schemas' own shapes — proving that here means
    // the frozen lists above pin the schema and the projection at the same time.
    expect(Object.keys(YieldRankingSummarySchema.shape)).toEqual(EXPECTED_ROW_KEYS);
    expect(Object.keys(YieldRankingSummaryProvenanceSchema.shape)).toEqual(EXPECTED_PROVENANCE_KEYS);
    expect(Object.keys(YieldRankingSummarySourceRiskSchema.shape)).toEqual(EXPECTED_SOURCE_RISK_KEYS);
    expect(Object.keys(YieldRankingSummaryAltSourceSchema.shape)).toEqual(EXPECTED_ALT_SOURCE_KEYS);
  });

  it("rejects detail-field leakage at the row schema boundary", () => {
    const summary = projectYieldRankingsSummary(makeDetailedResponse(1));
    expect(
      YieldRankingSummarySchema.safeParse({
        ...summary.rankings[0],
        altSources: [{ ...(summary.rankings[0].altSources?.[0] ?? {}), yieldSource: "Detail-only label" }],
      }).success,
    ).toBe(false);
  });

  it("stays within the production-shaped raw, gzip and per-row payload budgets", () => {
    const summary = projectYieldRankingsSummary(makeDetailedResponse(CURRENT_SCALE_RANKING_COUNT));
    const json = JSON.stringify(summary);
    const rawBytes = new TextEncoder().encode(json).byteLength;
    const gzipBytes = gzipSync(json, { level: 9 }).byteLength;

    expect(rawBytes).toBeLessThanOrEqual(RAW_PAYLOAD_BUDGET_BYTES);
    expect(gzipBytes).toBeLessThanOrEqual(GZIP_PAYLOAD_BUDGET_BYTES);
    expect(gzipBytes / summary.rankings.length).toBeLessThanOrEqual(GZIP_BYTES_PER_ROW_BUDGET);
  });
});

// The summary contract became strict about `dataSource`, `altSources`,
// `rankDelta`, `rankChangeDriver` and `rankPysDelta` in the same release that
// started emitting them. The worker/CDN cache serves the pre-deploy payload
// for up to a full cache window after the deploy, so the schema MUST keep
// accepting that older shape — this fixture freezes it: no `_meta`, benchmark
// entries without `recordAgeSec`/`maxRecordAgeSec`, and none of the five
// fields. Deliberately NOT typed as `YieldRankingsSummaryResponse`: the point
// is that the wire schema admits a payload the current type would reject.
describe("pre-deploy summary payload compatibility", () => {
  it("parses a cached summary row that predates the strict-contract fields", () => {
    const preDeployPayload = {
      projection: "summary",
      rankings: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          currentApy: 4.32,
          apy30d: 4.28,
          yieldSource: "Aave",
          yieldSourceUrl: "https://app.aave.com",
          yieldType: "lending-vault",
          sourceTvlUsd: 2_654_149_397,
          pharosYieldScore: 61.4,
          pysNullReason: null,
          safetyScore: 82,
          safetyGrade: "B+",
          benchmarkKey: "USD",
          benchmarkLabel: "USD 3M T-Bill",
          benchmarkRate: 4.13,
          benchmarkIsFallback: false,
          yieldStability: 0.91,
          apyMin30d: 4.1,
          apyMax30d: 4.45,
          warningSignals: [],
          sourceRole: "canonical-holder",
          alternateSourceCount: 2,
        },
      ],
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
    };

    expect(preDeployPayload).not.toHaveProperty("_meta");
    expect(preDeployPayload.benchmarks.USD).not.toHaveProperty("recordAgeSec");
    expect(preDeployPayload.benchmarks.USD).not.toHaveProperty("maxRecordAgeSec");
    for (const field of ["dataSource", "altSources", "rankDelta", "rankChangeDriver", "rankPysDelta"]) {
      expect(preDeployPayload.rankings[0]).not.toHaveProperty(field);
    }

    const parsed = YieldRankingsSummaryResponseSchema.safeParse(preDeployPayload);
    expect(parsed.success).toBe(true);
  });
});
