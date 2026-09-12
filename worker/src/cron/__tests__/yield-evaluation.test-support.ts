import { withYieldBenchmarkStaticMeta } from "../yield-sync/benchmarks";
import type { EvaluateYieldSourcesInput } from "../yield-sync/evaluation";
import type { ResolvedYield } from "../yield-sync/types";

export function baseEvaluationInput(overrides: Partial<EvaluateYieldSourcesInput> = {}): EvaluateYieldSourcesInput {
  const startSec = overrides.startSec ?? 1776729600;
  return {
    resolved: [],
    startSec,
    sevenDaysAgoSec: startSec - 7 * 86400,
    safetyScores: new Map([["coin-a", { score: 80, grade: "B+" }]]),
    riskFreeRates: {
      USD: freshUsdBenchmark(startSec),
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
    },
    tier1PrevRates: new Map(),
    sourceHistory: new Map(),
    onChainCompatibilityHistoryById: new Map(),
    legacyDeterministicOnChainHistoryById: new Map(),
    legacyHistoryById: new Map(),
    prevTvlBySource: new Map(),
    legacyPrevTvlById: new Map(),
    prevBestSourceKeyByCoin: new Map(),
    sourceSwitchCount30dByCoin: new Map(),
    stablecoinSupplyById: new Map([["coin-a", 10_000_000]]),
    ...overrides,
  };
}

/**
 * Observation date for fixture benchmarks that are meant to read as current.
 * The classifiers apply each key's record-age bound against the real clock
 * (`YIELD_BENCHMARK_RECORD_MAX_AGE_SEC`), so a hard-coded 2026-04 stamp reads as
 * a rewound upstream months later. One day back of the fixture's own clock
 * leaves a full day of headroom inside the 5-day daily bound; a fixture that
 * wants a *stale* observation passes its own old date instead.
 */
const FIXTURE_NOW_MS = Date.now() - 86_400_000;
export const FRESH_BENCHMARK_RECORD_DATE = new Date(FIXTURE_NOW_MS).toISOString().slice(0, 10);

export function freshUsdBenchmark(observedAt: number, rate = 4.2) {
  const recordDate = FRESH_BENCHMARK_RECORD_DATE;
  return {
    ...withYieldBenchmarkStaticMeta("USD", {
      rate,
      recordDate,
      fetchedAt: observedAt,
      ageSeconds: 0,
      source: "fred-dgs3mo-test",
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: recordDate,
    lastMarketFetchedAt: observedAt,
    lastMarketSource: "fred-dgs3mo-test",
  };
}

export function resolvedYield(overrides: Partial<ResolvedYield>): ResolvedYield {
  return {
    currentApy: 5,
    apyBase: 5,
    apyReward: null,
    sourcePool: null,
    sourceTvlUsd: 1_000_000,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: "defillama:coin-a:base",
    sourceObservedAt: 1776729600,
    comparisonAnchorObservedAt: null,
    yieldSource: "Fixture source",
    yieldType: "lending-vault",
    ...overrides,
  };
}
