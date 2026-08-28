import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSourceRiskGoldenFixture,
  getSourceRiskGoldenRow,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";


import type { YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";



import {
  PRICE_DERIVED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
  SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
  COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
  LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
} from "../yield-helpers";
import { buildHistoryKey, type EvaluatedYieldSource } from "../yield-sync/evaluation";
import type { ParsedYieldBenchmarkMeta, ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  validateYieldRankingsPayloadForPublish,
} from "../yield-sync/publication";



// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.


const FIXED_NOW = new Date("2026-03-26T12:00:00.000Z");

const DEFAULT_YIELD_PUBLICATION_D1_TABLES: MockTableConfig[] = [
  { match: "pharos:yield-sync:daily-history-materialize", rows: [] },
  { match: "pharos:yield-sync:stale-yield-data-delete", rows: [] },
  { match: "pharos:yield-sync:yield-data-existing-ids", rows: [], first: null },
  { match: "pharos:yield-sync:orphan-yield-data-delete", rows: [] },
  { match: "pharos:yield-sync:history-retention-delete", rows: [] },
  { match: "pharos:yield-sync:daily-history-retention-delete", rows: [] },
  { match: "pharos:yield-sync:decision-retention-delete", rows: [] },
  { match: "pharos:yield-sync:decision-alternatives-retention-delete", rows: [] },
  { match: "pharos:yield-sync:ownership-handoff-delete", rows: [] },
  { match: "ranked_linked_generations", rows: [] },
  { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  { match: "INSERT OR REPLACE INTO yield_data", rows: [] },
  { match: "INSERT OR IGNORE INTO yield_history", rows: [] },
  { match: "INSERT OR REPLACE INTO yield_source_decisions", rows: [] },
  { match: "INSERT OR REPLACE INTO yield_source_decision_alternatives", rows: [] },
  { match: "INSERT OR REPLACE INTO yield_publication_generations", rows: [] },
  { match: "UPDATE yield_publication_generations", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_YIELD_PUBLICATION_D1_TABLES]);
}

function makeBenchmarkMeta(): ParsedYieldBenchmarkMeta {
  return {
    key: "USD",
    label: "USD 3M T-Bill",
    currency: "USD",
    rate: 4.2,
    recordDate: "2026-03-25",
    fetchedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    ageSeconds: 0,
    source: "fred-dgs3mo",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
    lastMarketRate: 4.2,
    lastMarketRecordDate: "2026-03-25",
    lastMarketFetchedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    lastMarketSource: "fred-dgs3mo",
  };
}

function makeYieldSourceMeta(): YieldSourceInputMeta {
  return {
    mode: "dex-cache",
    updatedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    ageSeconds: 0,
    poolCount: 1,
    fallbackMode: null,
  };
}

function makeSafetySnapshotMeta(): YieldSafetySnapshotMeta {
  return {
    kind: "ok",
    coverageRatio: 1,
    coveredCount: 1,
    trackedCount: 1,
    reason: null,
  };
}

function makeEvaluatedSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
  const benchmarkMeta = makeBenchmarkMeta();
  return {
    id: "test-coin",
    symbol: "TST",
    sourceKey: "defillama:test-source",
    yieldSource: "Test Source",
    yieldType: "lending-vault",
    currentApy: 4.8,
    apyBase: 4.8,
    apyReward: 0,
    sourcePool: null,
    sourceTvlUsd: 1_500_000,
    sourceRisk: null,
    sourceRiskPenalty: 1,
    sourceRiskPenaltyReason: "missing-neutral",
    sourceRiskPenaltyProvided: false,
    sourceRiskAdjustedUtility: 28,
    dataSource: "defillama",
    exchangeRate: null,
    sourceObservedAt: null,
    comparisonAnchorObservedAt: null,
    apy7d: 4.7,
    apy30d: 4.6,
    apyVarianceScore: 0.1,
    stdDev30d: 0.2,
    apyMin30d: 4.4,
    apyMax30d: 4.9,
    yieldStability: 0.9,
    safetyScore: 82,
    safetyGrade: "A-",
    yieldToRisk: 3.2,
    excessYield: 0.6,
    benchmarkKey: "USD",
    benchmarkLabel: benchmarkMeta.label!,
    benchmarkCurrency: benchmarkMeta.currency!,
    benchmarkRate: benchmarkMeta.rate,
    benchmarkRecordDate: benchmarkMeta.recordDate,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    benchmarkMeta,
    pharosYieldScore: 28,
    pysNullReason: null,
    sourceFreshness: "fresh",
    benchmarkFreshness: "healthy",
    calculationMode: "market-api",
    evidenceClass: "curated-observation",
    evidenceCompleteness: 1,
    scoreQualification: "rated",
    scoreQualified: true,
    prevExchangeRate: null,
    prevTvlUsd: 1_700_000,
    sourceDepthRatio: null,
    observationCount30d: null,
    sourceSwitchCount30d: null,
    anomalies: [],
    warnings: [],
    confidenceTier: "curated",
    rejected: false,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    safetyProvenance: "live-report-card",
    safetyReason: null,
    previousBestSourceKey: null,
    ...overrides,
  };
}

function buildPayloadWithObservedAt(sourceObservedAt: number, overrides: Partial<EvaluatedYieldSource> = {}) {
  const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
  const source = makeEvaluatedSource(overrides);
  const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
  const benchmark = makeBenchmarkMeta();
  const benchmarks: ParsedYieldBenchmarkRegistry = {
    USD: benchmark,
    EUR: null,
    CHF: null,
    GBP: null,
    JPY: null,
    MXN: null,
    BRL: null,
    AUD: null,
    CAD: null,
    RUB: null,
    TRY: null,
    SGD: null,
  };

  return buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources: [source],
    bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]),
    rankingProvenanceByKey: new Map([
      [
        buildHistoryKey(source.id, source.sourceKey),
        {
          sourceKey: source.sourceKey,
          sourceObservedAt,
          sourceAgeSeconds: Math.max(0, startSec - sourceObservedAt),
          comparisonAnchorObservedAt,
          comparisonAnchorAgeSeconds:
            comparisonAnchorObservedAt == null ? null : Math.max(0, startSec - comparisonAnchorObservedAt),
          confidenceTier: source.confidenceTier,
          selectionMethod: "confidence-weighted" as const,
          selectionReason: "test",
          sourceSwitch: false,
          previousBestSourceKey: null,
          usedLegacyHistory: false,
          usedDefaultSafety: false,
          benchmarkKey: source.benchmarkKey,
          benchmarkLabel: source.benchmarkLabel,
          benchmarkCurrency: source.benchmarkCurrency,
          benchmarkRate: source.benchmarkRate,
          benchmarkRecordDate: source.benchmarkRecordDate,
          benchmarkIsFallback: source.benchmarkIsFallback,
          benchmarkFallbackMode: source.benchmarkFallbackMode,
          benchmarkSelectionMode: source.benchmarkSelectionMode,
          benchmarkIsProxy: source.benchmarkIsProxy,
          anomalies: [],
        },
      ],
    ]),
    riskFreeRate: benchmark.rate,
    riskFreeRateMeta: benchmark,
    riskFreeRateRegistry: benchmarks,
    dlPoolsMeta: makeYieldSourceMeta(),
    safetySnapshot: makeSafetySnapshotMeta(),
    medianApy: 4.5,
    startSec,
  });
}

describe("buildYieldRankingsPayloadFromEvaluatedSources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not add data-stale before the cadence-derived threshold", () => {
    const thresholdSec = STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60);

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("adds data-stale once the cadence-derived threshold is exceeded", () => {
    const thresholdSec = STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60);

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
    expect(payload.rankings[0]?.sourceRole).toBe("degraded-canonical");
    expect(payload.rankings[0]?.pharosYieldScore).toBeNull();
    expect(payload.rankings[0]?.pysNullReason).toBe("source-stale");
    expect(payload.rankings[0]?.provenance).toMatchObject({
      sourceFreshness: "stale",
      scoreQualification: "NR",
      evidenceCompleteness: 0.8571,
      scoreQualified: false,
    });
  });

  it("does not add data-stale for healthy price-derived daily snapshots", () => {
    const thresholdSec = PRICE_DERIVED_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60, {
      dataSource: "price-derived",
      sourceKey: "price-derived",
    });

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("still adds data-stale when price-derived snapshots miss the extended threshold", () => {
    const thresholdSec = PRICE_DERIVED_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60, {
      dataSource: "price-derived",
      sourceKey: "price-derived",
    });

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for healthy supplemental protocol-api rows", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60, {
      dataSource: "protocol-api",
      sourceKey: "protocol-api:pendle:ethereum:0xpool",
    });

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("adds data-stale once supplemental protocol-api rows miss their cadence window", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60, {
      dataSource: "protocol-api",
      sourceKey: "protocol-api:pendle:ethereum:0xpool",
    });

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("keeps accepted slow NAV observations fresh through their three-day window", () => {
    const thresholdSec = SLOW_NAV_SOURCE_STALE_THRESHOLD_MS / 1000;
    const beforeBoundary = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec, {
      dataSource: "protocol-api",
      sourceKey: "protocol-api:hashnote-usyc",
    });
    const afterBoundary = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 1, {
      dataSource: "protocol-api",
      sourceKey: "protocol-api:hashnote-usyc",
    });

    expect(beforeBoundary.rankings[0]?.warningSignals).not.toContain("data-stale");
    expect(afterBoundary.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for a fresh comparison anchor", () => {
    const thresholdSec = COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000;
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(nowSec, {
      dataSource: "onchain",
      sourceKey: "onchain:test-coin",
      sourceObservedAt: nowSec,
      comparisonAnchorObservedAt: nowSec - thresholdSec + 60,
    });

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("adds data-stale when a fresh on-chain row uses an old comparison anchor", () => {
    const thresholdSec = COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000;
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(nowSec, {
      dataSource: "onchain",
      sourceKey: "onchain:test-coin",
      sourceObservedAt: nowSec,
      comparisonAnchorObservedAt: nowSec - thresholdSec - 60,
    });

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("keeps intentional price-derived anchors fresh through the 45-day source window", () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(nowSec, {
      dataSource: "price-derived",
      sourceKey: "price-derived",
      sourceObservedAt: nowSec,
      comparisonAnchorObservedAt: nowSec - 30 * 24 * 60 * 60,
    });

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("marks price-derived anchors stale after their 45-day source window", () => {
    const thresholdSec = LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000;
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const payload = buildPayloadWithObservedAt(nowSec, {
      dataSource: "price-derived",
      sourceKey: "price-derived",
      sourceObservedAt: nowSec,
      comparisonAnchorObservedAt: nowSec - thresholdSec - 60,
    });

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for healthy supplemental onchain rows", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60, {
      dataSource: "onchain",
      sourceKey: "aave-v3-onchain:ethereum:0xasset",
    });

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
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
      bestSourceKeyByCoin: new Map([[selected.id, selected.sourceKey]]),
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
});

describe("validateYieldRankingsPayloadForPublish", () => {
  it("allows a valid replacement when the previous rankings cache is malformed", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [{ value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) }],
        first: { value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) },
      },
    ]);
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

    expect(result).toEqual({ ok: true, validationFailures: 0 });
  });

  it("blocks malformed previous-cache recovery when the replacement has no rows", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [{ value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) }],
        first: { value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) },
      },
    ]);
    const payload = {
      ...buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000)),
      rankings: [],
    };

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

    expect(result).toEqual({
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    });
  });

  it("blocks publish when ranking IDs are duplicated", async () => {
    const db = mockD1();
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = [
      payload.rankings[0]!,
      {
        ...payload.rankings[0]!,
        yieldSource: "Duplicate Source",
      },
    ];

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

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
      bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
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
      bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
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
      bestSourceKeyByCoin: new Map([[selected.id, selected.sourceKey]]),
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
      bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
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
