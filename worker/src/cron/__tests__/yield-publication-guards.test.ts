import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSourceRiskGoldenFixture,
  getSourceRiskGoldenRow,
  mergeSourceRiskGoldenFixtures,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { computePysRewardShare, derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";

import {
  PRICE_DERIVED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
  SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
  COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
  LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
} from "../yield-helpers";
import { buildHistoryKey } from "../yield-sync/evaluation";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "../yield-sync/benchmarks";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  validateYieldRankingsPayloadForPublish,
} from "../yield-sync/publication";
import type { PreviousYieldPublicationSnapshot } from "../yield-sync/publication";
import {
  FIXED_NOW,
  buildPayloadWithObservedAt,
  makeBenchmarkMeta,
  makeEvaluatedSource,
  makePublicationViews,
  makeSafetySnapshotMeta,
  makeYieldSourceMeta,
} from "./yield-publication.test-support";

function previousSnapshot(
  rankings: readonly { id?: unknown; dataSource?: unknown; provenance?: unknown }[],
  status: PreviousYieldPublicationSnapshot["status"] = "ok",
): PreviousYieldPublicationSnapshot {
  return {
    status,
    rankings,
    malformed: status !== "missing" && status !== "ok",
  };
}

describe("buildYieldRankingsPayloadFromEvaluatedSources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type FreshnessBoundaryCase = {
    label: string;
    boundary: string;
    sourceObservedAt: (nowSec: number) => number;
    overrides: Parameters<typeof buildPayloadWithObservedAt>[1];
    expectedStale: boolean;
    expectedRole: string;
  };

  const freshnessBoundaryCases: FreshnessBoundaryCase[] = [
    {
      label: "does not add data-stale before the cadence-derived threshold",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec - STALE_THRESHOLD_MS / 1000 + 60,
      overrides: {},
      expectedStale: false,
      expectedRole: "canonical-holder",
    },
    {
      label: "adds data-stale once the cadence-derived threshold is exceeded",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec - STALE_THRESHOLD_MS / 1000 - 60,
      overrides: {},
      expectedStale: true,
      expectedRole: "degraded-canonical",
    },
    {
      label: "does not add data-stale for healthy price-derived daily snapshots",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec - PRICE_DERIVED_STALE_THRESHOLD_MS / 1000 + 60,
      overrides: { dataSource: "price-derived", sourceKey: "price-derived" },
      expectedStale: false,
      expectedRole: "fallback-proxy",
    },
    {
      label: "still adds data-stale when price-derived snapshots miss the extended threshold",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec - PRICE_DERIVED_STALE_THRESHOLD_MS / 1000 - 60,
      overrides: { dataSource: "price-derived", sourceKey: "price-derived" },
      expectedStale: true,
      expectedRole: "fallback-proxy",
    },
    {
      label: "does not add data-stale for healthy supplemental protocol-api rows",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec - SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000 + 60,
      overrides: {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
      },
      expectedStale: false,
      expectedRole: "canonical-holder",
    },
    {
      label: "adds data-stale once supplemental protocol-api rows miss their cadence window",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec - SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000 - 60,
      overrides: {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
      },
      expectedStale: true,
      expectedRole: "degraded-canonical",
    },
    {
      label: "keeps accepted slow NAV observations fresh through their three-day window",
      boundary: "at threshold",
      sourceObservedAt: (nowSec) => nowSec - SLOW_NAV_SOURCE_STALE_THRESHOLD_MS / 1000,
      overrides: {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:hashnote-usyc",
      },
      expectedStale: false,
      expectedRole: "canonical-holder",
    },
    {
      label: "keeps accepted slow NAV observations fresh through their three-day window",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec - SLOW_NAV_SOURCE_STALE_THRESHOLD_MS / 1000 - 1,
      overrides: {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:hashnote-usyc",
      },
      expectedStale: true,
      expectedRole: "degraded-canonical",
    },
    {
      label: "does not add data-stale for a fresh comparison anchor",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec,
      overrides: {
        dataSource: "onchain",
        sourceKey: "onchain:test-coin",
        sourceObservedAt: Math.floor(FIXED_NOW.getTime() / 1000),
        comparisonAnchorObservedAt:
          Math.floor(FIXED_NOW.getTime() / 1000) - COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000 + 60,
      },
      expectedStale: false,
      expectedRole: "canonical-holder",
    },
    {
      label: "adds data-stale when a fresh on-chain row uses an old comparison anchor",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec,
      overrides: {
        dataSource: "onchain",
        sourceKey: "onchain:test-coin",
        sourceObservedAt: Math.floor(FIXED_NOW.getTime() / 1000),
        comparisonAnchorObservedAt:
          Math.floor(FIXED_NOW.getTime() / 1000) - COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000 - 60,
      },
      expectedStale: true,
      expectedRole: "degraded-canonical",
    },
    {
      label: "keeps intentional price-derived anchors fresh through the 45-day source window",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec,
      overrides: {
        dataSource: "price-derived",
        sourceKey: "price-derived",
        sourceObservedAt: Math.floor(FIXED_NOW.getTime() / 1000),
        comparisonAnchorObservedAt: Math.floor(FIXED_NOW.getTime() / 1000) - 30 * 24 * 60 * 60,
      },
      expectedStale: false,
      expectedRole: "fallback-proxy",
    },
    {
      label: "marks price-derived anchors stale after their 45-day source window",
      boundary: "after threshold",
      sourceObservedAt: (nowSec) => nowSec,
      overrides: {
        dataSource: "price-derived",
        sourceKey: "price-derived",
        sourceObservedAt: Math.floor(FIXED_NOW.getTime() / 1000),
        comparisonAnchorObservedAt:
          Math.floor(FIXED_NOW.getTime() / 1000) - LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000 - 60,
      },
      expectedStale: true,
      expectedRole: "fallback-proxy",
    },
    {
      label: "does not add data-stale for healthy supplemental onchain rows",
      boundary: "before threshold",
      sourceObservedAt: (nowSec) => nowSec - SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000 + 60,
      overrides: {
        dataSource: "onchain",
        sourceKey: "aave-v3-onchain:ethereum:0xasset",
      },
      expectedStale: false,
      expectedRole: "canonical-holder",
    },
  ];

  it.each(freshnessBoundaryCases)("$label — $boundary", (testCase) => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(testCase.sourceObservedAt(nowSec), testCase.overrides);
    const ranking = payload.rankings[0];
    const expectedSourceFreshness = testCase.expectedStale ? "stale" : "fresh";

    expect(ranking).toMatchObject({
      warningSignals: testCase.expectedStale
        ? expect.arrayContaining(["data-stale"])
        : expect.not.arrayContaining(["data-stale"]),
      sourceRole: testCase.expectedRole,
      pharosYieldScore: testCase.expectedStale ? null : 28,
      pysNullReason: testCase.expectedStale ? "source-stale" : null,
      provenance: expect.objectContaining({
        sourceFreshness: expectedSourceFreshness,
        scoreQualification: testCase.expectedStale ? "NR" : "rated",
        scoreQualified: !testCase.expectedStale,
        ...(testCase.expectedStale ? { evidenceCompleteness: 0.8571 } : {}),
      }),
    });
  });

  it("populates measured source-risk fields and keeps unsupported fields neutral or null", () => {
    const observedAt = Math.floor(FIXED_NOW.getTime() / 1000) - 300;
    const payload = buildPayloadWithObservedAt(observedAt, {
      currentApy: 5,
      apyReward: 1,
      sourceRiskPenalty: 1,
      sourceDepthRatio: 0.25,
      observationCount30d: 12,
      sourceSwitchCount30d: 2,
    });

    expect(payload.rankings[0]?.sourceRisk).toMatchObject({
      sourceRiskScore: 0,
      sourceRiskPenalty: 1,
      sourceDepthRatio: 0.25,
      rewardShare: 0.2,
      sourceAgeSeconds: 300,
      observationCount30d: 12,
      sourceSwitchCount30d: 2,
      deploymentPlace: "strategy-vault",
      venueProtocol: null,
      venueChain: null,
      venueRiskTier: "unknown",
    });
  });

  it("keeps reward share null when APY cannot be decomposed reliably", () => {
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000), {
      currentApy: 5,
      apyReward: null,
    });

    expect(payload.rankings[0]?.sourceRisk?.rewardShare).toBeNull();
  });

  it("populates source-switch APY30d delta when the previous selected source is evaluated", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const selected = makeEvaluatedSource({
      sourceKey: "defillama:selected",
      yieldSource: "Selected",
      currentApy: 5.3,
      apy30d: 5,
      pharosYieldScore: 50,
      confidenceTier: "curated",
      previousBestSourceKey: "price-derived:previous",
    });
    const previous = makeEvaluatedSource({
      sourceKey: "price-derived:previous",
      yieldSource: "Previous",
      currentApy: 3.4,
      apy30d: 3.2,
      pharosYieldScore: 20,
      confidenceTier: "fallback",
      dataSource: "price-derived",
      previousBestSourceKey: "price-derived:previous",
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [selected, previous],
      publicationViews: makePublicationViews(
        [selected, previous],
        new Map([[selected.id, selected.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(payload.rankings[0]?.decisionLedger?.sourceSwitch).toBe(true);
    expect(payload.rankings[0]?.decisionLedger?.previousBestSourceKey).toBe("price-derived:previous");
    expect(payload.rankings[0]?.decisionLedger?.apy30dDeltaFromPrevious).toBeCloseTo(1.8, 6);
  });

  it("keeps a benchmark-degraded row scored and adds the degradation warning", () => {
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000), {
      benchmarkFreshness: "degraded",
    });
    const ranking = payload.rankings[0];

    expect(ranking?.warningSignals).toContain("benchmark-degraded");
    expect(ranking?.warningSignals).not.toContain("benchmark-stale");
    expect(ranking?.pharosYieldScore).toBe(28);
    expect(ranking?.pysNullReason).toBeNull();
    expect(ranking?.sourceRole).toBe("degraded-canonical");
    expect(ranking?.provenance).toMatchObject({
      benchmarkFreshness: "degraded",
      scoreQualification: "rated",
      scoreQualified: true,
    });
  });

  it("nulls the score and names the benchmark when the benchmark feed is stale", () => {
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000), {
      benchmarkFreshness: "stale",
    });
    const ranking = payload.rankings[0];

    expect(ranking?.warningSignals).toContain("benchmark-stale");
    expect(ranking?.warningSignals).not.toContain("data-stale");
    expect(ranking?.pharosYieldScore).toBeNull();
    expect(ranking?.pysNullReason).toBe("benchmark-stale");
    expect(ranking?.sourceRole).toBe("degraded-canonical");
    expect(ranking?.provenance).toMatchObject({
      sourceFreshness: "fresh",
      benchmarkFreshness: "stale",
      scoreQualification: "NR",
      scoreQualified: false,
    });
  });

  it.each([
    {
      label: "a proxy-selected row with healthy meta stays healthy",
      meta: makeBenchmarkMeta(),
      overrides: { benchmarkSelectionMode: "fallback-usd" as const },
      expectedFreshness: "healthy",
      expectedWarning: null,
      expectedScore: 28,
    },
    {
      label: "a retained fallback meta degrades",
      meta: makeBenchmarkMeta({ isFallback: true, fallbackMode: "retained" }),
      overrides: {},
      expectedFreshness: "degraded",
      expectedWarning: "benchmark-degraded",
      expectedScore: 28,
    },
    {
      label: "an observation past the 48h fetch TTL goes stale",
      meta: makeBenchmarkMeta({ ageSeconds: YIELD_BENCHMARK_SCORE_TTL_SEC + 1 }),
      overrides: {},
      expectedFreshness: "stale",
      expectedWarning: "benchmark-stale",
      expectedScore: null,
    },
  ])(
    "recomputes freshness from the row meta when the row publishes none — $label",
    ({ meta, overrides, expectedFreshness, expectedWarning, expectedScore }) => {
      const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000), {
        // A row that publishes no freshness (legacy/absent evaluation output) must
        // be classified from its own benchmark meta.
        benchmarkFreshness: undefined,
        benchmarkMeta: meta,
        ...overrides,
      });
      const ranking = payload.rankings[0];

      expect(ranking?.provenance?.benchmarkFreshness).toBe(expectedFreshness);
      if (expectedWarning == null) {
        // A1: a documented proxy selection is not a degraded feed.
        expect(ranking?.warningSignals).not.toContain("benchmark-degraded");
        expect(ranking?.warningSignals).not.toContain("benchmark-stale");
      } else {
        expect(ranking?.warningSignals).toContain(expectedWarning);
      }
      expect(ranking?.pharosYieldScore).toBe(expectedScore);
      expect(ranking?.pysNullReason).toBe(expectedScore == null ? "benchmark-stale" : null);
    },
  );

  it("prefers the source-stale reason when both the source and the benchmark are stale", () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(nowSec - STALE_THRESHOLD_MS / 1000 - 60, {
      benchmarkFreshness: "stale",
    });
    const ranking = payload.rankings[0];

    expect(ranking?.warningSignals).toEqual(expect.arrayContaining(["data-stale", "benchmark-stale"]));
    expect(ranking?.pharosYieldScore).toBeNull();
    expect(ranking?.pysNullReason).toBe("source-stale");
    expect(ranking?.provenance).toMatchObject({
      sourceFreshness: "stale",
      benchmarkFreshness: "stale",
      scoreQualification: "NR",
      scoreQualified: false,
    });
  });
});

describe("validateYieldRankingsPayloadForPublish", () => {
  it.each([
    {
      label: "missing",
      snapshot: previousSnapshot([], "missing"),
      currentRankings: 0,
      expected: { ok: true, validationFailures: 0 },
    },
    {
      label: "malformed JSON",
      snapshot: previousSnapshot([], "malformed-json"),
      currentRankings: 1,
      expected: { ok: true, validationFailures: 0 },
    },
    {
      label: "malformed payload",
      snapshot: previousSnapshot([], "malformed-payload"),
      currentRankings: 1,
      expected: { ok: true, validationFailures: 0 },
    },
    {
      label: "empty",
      snapshot: previousSnapshot([]),
      currentRankings: 0,
      expected: { ok: true, validationFailures: 0 },
    },
    {
      label: "small",
      snapshot: previousSnapshot(Array.from({ length: 4 }, (_, index) => ({ id: `previous-${index}` }))),
      currentRankings: 1,
      expected: { ok: true, validationFailures: 0 },
    },
    {
      label: "severe shrink",
      snapshot: previousSnapshot(Array.from({ length: 10 }, (_, index) => ({ id: `previous-${index}` }))),
      currentRankings: 1,
      expected: { ok: false, validationFailures: 1, reason: "rankings-payload-shrunk" },
    },
  ])("keeps the $label previous snapshot decision stable", async ({ snapshot, currentRankings, expected }) => {
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = currentRankings === 0 ? [] : [payload.rankings[0]!];

    const result = await validateYieldRankingsPayloadForPublish(payload, snapshot);

    expect(result).toEqual(expected);
  });


  it("blocks malformed previous-cache recovery when the replacement has no rows", async () => {
    const payload = {
      ...buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000)),
      rankings: [],
    };

    const result = await validateYieldRankingsPayloadForPublish(
      payload,
      previousSnapshot([], "malformed-json"),
    );

    expect(result).toEqual({
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    });
  });

  it("blocks publish when ranking IDs are duplicated", async () => {
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = [
      payload.rankings[0]!,
      {
        ...payload.rankings[0]!,
        yieldSource: "Duplicate Source",
      },
    ];

    const result = await validateYieldRankingsPayloadForPublish(payload, previousSnapshot([], "missing"));

    expect(result).toEqual({
      ok: false,
      validationFailures: 1,
      reason: "duplicate-ranking-ids",
    });
  });

  it("keeps alternate sources with distinct source keys even when display labels match", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      yieldSource: "Shared Venue",
      currentApy: 6,
      apy30d: 6,
      pharosYieldScore: 90,
    });
    const altA = makeEvaluatedSource({
      sourceKey: "defillama:alt-a",
      yieldSource: "Shared Venue",
      currentApy: 5,
      apy30d: 7,
      apyReward: 2.5,
      pharosYieldScore: 80,
      sourceRiskAdjustedUtility: 20,
      sourceRiskPenalty: 1.5,
      sourceRiskPenaltyReason: "provided",
      sourceRiskPenaltyProvided: false,
      sourceDepthRatio: 0.0005,
      observationCount30d: 4,
    });
    const altB = makeEvaluatedSource({
      sourceKey: "defillama:alt-b",
      yieldSource: "Shared Venue",
      currentApy: 4,
      apy30d: 4.2,
      pharosYieldScore: 70,
      sourceRiskAdjustedUtility: 40,
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [best, altA, altB],
      publicationViews: makePublicationViews(
        [best, altA, altB],
        new Map([[best.id, best.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map([
        [
          buildHistoryKey(best.id, best.sourceKey),
          {
            sourceObservedAt: Math.floor(Date.now() / 1000),
          },
        ],
      ]),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(payload.rankings[0]?.altSources.map((source) => source.sourceKey)).toEqual([
      "defillama:alt-a",
      "defillama:alt-b",
    ]);
    const ranking = payload.rankings[0];
    const firstAlt = ranking?.altSources[0];
    expect(ranking?.sourceRole).toBe("canonical-holder");
    expect(firstAlt).toMatchObject({
      sourceRole: "audit-alternate",
      confidenceTier: "curated",
      calculationMode: "market-api",
      evidenceClass: "curated-observation",
      evidenceCompleteness: 1,
      scoreQualification: "rated",
      selectionRank: 2,
      rejectionReasonCode: "unspecified",
    });
    expect(ranking?.alternateSummary).toMatchObject({
      count: 2,
      alternateApySpread: 1,
      bestAlternateByApy: {
        sourceKey: "defillama:alt-a",
        apy30dDelta: 1,
        sourceRole: "audit-alternate",
      },
      bestRiskAdjustedAlternate: {
        sourceKey: "defillama:alt-b",
        riskAdjustedUtility: 40,
      },
    });
    expect(firstAlt?.sourceRisk).toMatchObject({
      sourceRiskPenalty: 1.5,
      sourceDepthRatio: 0.0005,
      rewardShare: 0.5,
      observationCount30d: 4,
      sourceSwitchCount30d: null,
      deploymentPlace: "strategy-vault",
      venueRiskTier: "unknown",
    });
    expect((ranking as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
    expect((firstAlt as unknown as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
  });

  it("deduplicates alternate source keys using the richer current APY row", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      yieldSource: "Best Source",
      currentApy: 6,
      apy30d: 6,
      pharosYieldScore: 90,
    });
    const lowerRankedDuplicate = makeEvaluatedSource({
      sourceKey: "defillama:alt",
      yieldSource: "Alternate Source",
      currentApy: 4,
      apy30d: 4,
      confidenceTier: "curated",
      dataSource: "defillama",
      pharosYieldScore: 80,
    });
    const richerDuplicate = makeEvaluatedSource({
      sourceKey: "defillama:alt",
      yieldSource: "Alternate Source",
      currentApy: 8,
      apy30d: 7,
      confidenceTier: "discovered",
      dataSource: "defillama-auto",
      pharosYieldScore: 70,
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [best, lowerRankedDuplicate, richerDuplicate],
      publicationViews: makePublicationViews(
        [best, lowerRankedDuplicate, richerDuplicate],
        new Map([[best.id, best.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    const ranking = payload.rankings[0];
    expect(ranking?.altSources).toHaveLength(1);
    expect(ranking?.altSources[0]).toMatchObject({
      sourceKey: "defillama:alt",
      currentApy: 8,
      apy30d: 7,
      confidenceTier: "discovered",
      selectionRank: 2,
    });
    expect(ranking?.alternateSummary?.bestAlternateByApy).toMatchObject({
      sourceKey: "defillama:alt",
      currentApy: 8,
      apy30d: 7,
    });
  });

  it("publishes opportunity-level risk evidence for selected and alternate sources", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const selectedOpportunityRisk = {
      opportunityClass: "lending" as const,
      underlyingSafetyScore: 82,
      opportunitySafetyScore: 77,
      opportunitySafetyPenalty: 5,
      venueReviewed: true,
      missingCriticalEvidence: [],
    };
    const alternateOpportunityRisk = {
      opportunityClass: "structured-tranche" as const,
      underlyingSafetyScore: 74,
      opportunitySafetyScore: null,
      opportunitySafetyPenalty: null,
      venueReviewed: false,
      missingCriticalEvidence: ["venue-review" as const, "market-size" as const],
    };
    const selected = makeEvaluatedSource({
      sourceKey: "defillama:selected-opportunity",
      yieldSource: "Selected Opportunity",
      currentApy: 6,
      pharosYieldScore: 90,
      sourceRisk: { opportunityRisk: selectedOpportunityRisk },
    });
    const alternate = makeEvaluatedSource({
      sourceKey: "defillama:alternate-opportunity",
      yieldSource: "Alternate Opportunity",
      currentApy: 5,
      pharosYieldScore: 80,
      sourceRisk: { opportunityRisk: alternateOpportunityRisk },
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [selected, alternate],
      publicationViews: makePublicationViews(
        [selected, alternate],
        new Map([[selected.id, selected.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(payload.rankings[0]?.sourceRisk?.opportunityRisk).toEqual(selectedOpportunityRisk);
    expect(payload.rankings[0]?.altSources[0]?.sourceRisk?.opportunityRisk).toEqual(alternateOpportunityRisk);
  });

  it("publishes golden source-risk rows only under nested public sourceRisk", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const rewardHeavyRow = getSourceRiskGoldenRow("reward-heavy");
    const staleAgeRow = getSourceRiskGoldenRow("stale-source-age");
    const best = makeEvaluatedSource({
      sourceKey: "golden:reward-heavy",
      yieldSource: "Golden Reward Heavy",
      currentApy: 10,
      apyReward: 9,
      sourceRisk: buildSourceRiskGoldenFixture("reward-heavy"),
      sourceRiskPenalty: rewardHeavyRow.expectedDerivedPenalty,
      sourceRiskPenaltyReason: "provided",
      sourceRiskPenaltyProvided: true,
    });
    const alt = makeEvaluatedSource({
      sourceKey: "golden:stale-source-age",
      yieldSource: "Golden Stale Source",
      sourceRisk: buildSourceRiskGoldenFixture("stale-source-age"),
      sourceRiskPenalty: staleAgeRow.expectedDerivedPenalty,
      sourceRiskPenaltyReason: "provided",
      sourceRiskPenaltyProvided: true,
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [best, alt],
      publicationViews: makePublicationViews(
        [best, alt],
        new Map([[best.id, best.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    const ranking = payload.rankings[0];
    const firstAlt = ranking?.altSources[0];
    expect(ranking?.sourceRisk).toMatchObject({
      sourceRiskPenalty: rewardHeavyRow.expectedDerivedPenalty,
      rewardShare: rewardHeavyRow.input.rewardShare,
    });
    expect(firstAlt?.sourceRisk).toMatchObject({
      sourceRiskPenalty: staleAgeRow.expectedDerivedPenalty,
      sourceAgeSeconds: staleAgeRow.input.sourceAgeSeconds,
    });
    expect((ranking as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
    expect((firstAlt as unknown as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
  });

});

describe("buildYieldRankingsPayloadFromEvaluatedSources source-risk invariants", () => {
  it("reproduces every published source-risk penalty and reward share from the row's published terms", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    // The scored penalties come from golden literals (never from the derivation this
    // test runs), so a publisher that bypasses `derivePysSourceRiskPenalty` — or
    // publishes terms the score never used — cannot satisfy the invariant below.
    const rewardHeavy = getSourceRiskGoldenRow("reward-heavy");
    const staleAge = getSourceRiskGoldenRow("stale-source-age");
    const churn = getSourceRiskGoldenRow("source-switch-churn");
    const venueWeight = 3;
    const venuePenalty = derivePysSourceRiskPenalty({ venueRiskWeighted: venueWeight, venueRiskTier: "medium" });

    const selected = makeEvaluatedSource({
      sourceKey: "golden:reward-heavy",
      yieldSource: "Golden Reward Heavy",
      currentApy: 10,
      apyBase: 1,
      apyReward: 9,
      sourceRisk: buildSourceRiskGoldenFixture("reward-heavy"),
      sourceRiskPenalty: rewardHeavy.expectedDerivedPenalty,
    });
    const staleAgeAlt = makeEvaluatedSource({
      sourceKey: "golden:stale-source-age",
      yieldSource: "Golden Stale Source",
      sourceRisk: buildSourceRiskGoldenFixture("stale-source-age"),
      sourceRiskPenalty: staleAge.expectedDerivedPenalty,
    });
    const thinDepthAlt = makeEvaluatedSource({
      sourceKey: "golden:thin-depth-bootstrap",
      yieldSource: "Golden Thin Depth",
      sourceRisk: mergeSourceRiskGoldenFixtures(["low-source-depth", "bootstrap-observation-count"], {
        sourceRiskPenalty: 1.55,
      }),
      sourceRiskPenalty: 1.55,
    });
    // A9: the stored share (0.99) contradicts the row's own decomposition — a base-only
    // payload proves the reward contribution is zero — so the published terms and the
    // published penalty must both come from the re-derived share.
    const storedRewardShareAlt = makeEvaluatedSource({
      sourceKey: "golden:stored-reward-share",
      yieldSource: "Golden Stored Reward Share",
      currentApy: 5,
      apyBase: 5,
      apyReward: null,
      sourceRisk: mergeSourceRiskGoldenFixtures(["reward-heavy"], {
        sourceRiskPenalty: 1,
        rewardShare: 0.99,
      }),
      sourceRiskPenalty: 1,
    });
    const venueAlt = makeEvaluatedSource({
      sourceKey: "golden:venue-weighted",
      yieldSource: "Golden Venue Weighted",
      sourceRisk: buildSourceRiskGoldenFixture("missing-safety", {
        venueRiskWeighted: venueWeight,
        venueRiskTier: "medium",
      }),
      sourceRiskPenalty: venuePenalty,
    });
    // B42: only a best row publishes the switch count, and only a best row's penalty
    // may include the churn term.
    const churnSelected = makeEvaluatedSource({
      id: "churn-coin",
      symbol: "CHN",
      sourceKey: "golden:source-switch-churn",
      yieldSource: "Golden Source Churn",
      sourceSwitchCount30d: churn.input.sourceSwitchCount30d,
      sourceRisk: buildSourceRiskGoldenFixture("source-switch-churn"),
      sourceRiskPenalty: churn.expectedDerivedPenalty,
    });
    const evaluatedSources = [
      selected,
      staleAgeAlt,
      thinDepthAlt,
      storedRewardShareAlt,
      venueAlt,
      churnSelected,
    ];

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources,
      publicationViews: makePublicationViews(
        evaluatedSources,
        new Map([
          [selected.id, selected.sourceKey],
          [churnSelected.id, churnSelected.sourceKey],
        ]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(payload.rankings).toHaveLength(2);
    const altRows = payload.rankings.flatMap((ranking) => ranking.altSources ?? []);
    expect(altRows).toHaveLength(4);

    // Invariant 1 — for every best row and every alternate row, the published penalty
    // is exactly the derivation from that row's own published terms.
    const penaltyRows = [
      ...payload.rankings.map((ranking) => ({ label: ranking.id, risk: ranking.sourceRisk })),
      ...altRows.map((alt) => ({ label: alt.sourceKey, risk: alt.sourceRisk })),
    ];
    for (const { label, risk } of penaltyRows) {
      expect(risk, label).toBeTruthy();
      expect(Number.isFinite(risk?.sourceRiskPenalty), label).toBe(true);
      expect(risk?.sourceRiskPenalty, label).toBe(
        derivePysSourceRiskPenalty({
          rewardShare: risk?.rewardShare ?? null,
          sourceDepthRatio: risk?.sourceDepthRatio ?? null,
          sourceAgeSeconds: risk?.sourceAgeSeconds ?? null,
          sourceSwitchCount30d: risk?.sourceSwitchCount30d ?? null,
          observationCount30d: risk?.observationCount30d ?? null,
          venueRiskTier: risk?.venueRiskTier ?? null,
          venueRiskWeighted: risk?.venueRiskWeighted ?? null,
          dependencyConcentrationSeverity: risk?.dependencyConcentration?.severity ?? null,
        }),
      );
    }

    // Invariant 2 — a best row's published reward share is reproducible from its own
    // published decomposition (`apyReward / currentApy`, or 0 for a base-only row).
    for (const ranking of payload.rankings) {
      const expectedRewardShare =
        computePysRewardShare(ranking.apyReward ?? null, ranking.currentApy) ??
        (ranking.apyReward == null && ranking.apyBase != null && ranking.apyBase >= ranking.currentApy - 1e-9
          ? 0
          : null);
      expect(ranking.sourceRisk?.rewardShare ?? null, ranking.id).toBe(expectedRewardShare);
    }

    // Invariant 3 — alternate rows publish no APY decomposition, so the same rule is
    // applied to the candidate terms the row was built from.
    const termsBySourceKey = new Map(evaluatedSources.map((source) => [source.sourceKey, source]));
    for (const alt of altRows) {
      const source = termsBySourceKey.get(alt.sourceKey);
      expect(source, alt.sourceKey).toBeDefined();
      const apyReward = source?.apyReward ?? null;
      const apyBase = source?.apyBase ?? null;
      const currentApy = source?.currentApy ?? 0;
      const expectedRewardShare =
        computePysRewardShare(apyReward, currentApy) ??
        (apyReward == null && apyBase != null && apyBase >= currentApy - 1e-9 ? 0 : null);
      expect(alt.sourceRisk?.rewardShare ?? null, alt.sourceKey).toBe(expectedRewardShare);
    }
  });
});
