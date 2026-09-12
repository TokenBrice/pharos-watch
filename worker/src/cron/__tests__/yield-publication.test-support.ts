import type { YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { buildHistoryKey, type EvaluatedYieldSource } from "../yield-sync/evaluation";
import type { ParsedYieldBenchmarkMeta, ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import { buildYieldPublicationViews, buildYieldRankingsPayloadFromEvaluatedSources } from "../yield-sync/publication";

export const FIXED_NOW = new Date("2026-03-26T12:00:00.000Z");

const DEFAULT_YIELD_PUBLICATION_D1_TABLES: MockTableConfig[] = [
  { match: "pharos:yield-sync:daily-history-materialize", rows: [] },
  { match: "pharos:yield-sync:stale-yield-data-delete", rows: [] },
  { match: "pharos:yield-sync:yield-data-existing-ids", rows: [], first: null },
  { match: "pharos:yield-sync:orphan-yield-data-delete", rows: [] },
  { match: "pharos:yield-sync:history-retention-delete", rows: [] },
  { match: "pharos:yield-sync:daily-history-retention-delete", rows: [] },
  { match: "pharos:yield-sync:decision-retention-delete", rows: [] },
  { match: "pharos:yield-sync:decision-retention-delete-candidates", rows: [] },
  { match: "pharos:yield-sync:decision-alternatives-retention-delete", rows: [] },
  { match: "pharos:yield-sync:abandoned-staged-generation-finalize", rows: [] },
  { match: "pharos:yield-sync:publication-generation-retention-delete", rows: [] },
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

export function makePublicationViews(
  evaluatedSources: EvaluatedYieldSource[],
  bestSourceKeyByCoin: Map<string, string>,
  startSec: number,
) {
  return buildYieldPublicationViews({
    evaluatedSources,
    bestSourceKeyByCoin,
    startSec,
    dlPoolsMeta: makeYieldSourceMeta(),
  }).viewsByCoinId;
}

export function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_YIELD_PUBLICATION_D1_TABLES]);
}

export function makeBenchmarkMeta(
  overrides: Partial<ParsedYieldBenchmarkMeta> = {},
): ParsedYieldBenchmarkMeta {
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
    ...overrides,
  };
}

const NULL_BENCHMARK_CURRENCIES = ["EUR", "CHF", "GBP", "JPY", "MXN", "BRL", "AUD", "CAD", "RUB", "TRY", "SGD"] as const;

/** USD-backed registry with every other tracked currency left empty. */
export function makeBenchmarkRegistry(
  usd: ParsedYieldBenchmarkMeta,
  overrides: Partial<ParsedYieldBenchmarkRegistry> = {},
): ParsedYieldBenchmarkRegistry {
  const registry = { USD: usd, ...overrides } as ParsedYieldBenchmarkRegistry;
  for (const currency of NULL_BENCHMARK_CURRENCIES) {
    if (!(currency in registry)) registry[currency] = null;
  }
  return registry;
}

export function makeYieldSourceMeta(): YieldSourceInputMeta {
  return {
    mode: "dex-cache",
    updatedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    ageSeconds: 0,
    poolCount: 1,
    fallbackMode: null,
  };
}

export function makeSafetySnapshotMeta(): YieldSafetySnapshotMeta {
  return {
    kind: "ok",
    coverageRatio: 1,
    coveredCount: 1,
    trackedCount: 1,
    reason: null,
  };
}

export function makeEvaluatedSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
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
    // apy30d (4.6) - benchmarkRate (4.2): evaluation.ts writes the row's own
    // excess, so a fixture literal that disagrees launders both numbers.
    excessYield: 0.4,
    benchmarkKey: "USD",
    benchmarkLabel: benchmarkMeta.label!,
    benchmarkCurrency: benchmarkMeta.currency!,
    benchmarkRate: benchmarkMeta.rate,
    usdBenchmarkRate: benchmarkMeta.rate,
    hurdleRebase: 0,
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

export function buildPayloadWithObservedAt(
  sourceObservedAt: number,
  overrides: Partial<EvaluatedYieldSource> = {},
  options: {
    /**
     * Registry entries the payload publishes alongside the USD reference. The
     * row's own benchmark fields always come from the evaluated source, so a
     * non-USD case must override both sides to stay coherent.
     */
    benchmarkRegistry?: Partial<ParsedYieldBenchmarkRegistry>;
  } = {},
) {
  const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
  const source = makeEvaluatedSource(overrides);
  const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
  const benchmark = makeBenchmarkMeta();
  const benchmarks = makeBenchmarkRegistry(benchmark, options.benchmarkRegistry);

  return buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources: [source],
    publicationViews: makePublicationViews([source], new Map([[source.id, source.sourceKey]]), startSec),
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
