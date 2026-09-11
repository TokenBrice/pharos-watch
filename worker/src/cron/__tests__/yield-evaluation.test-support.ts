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

export function freshUsdBenchmark(observedAt: number, rate = 4.2) {
  return {
    ...withYieldBenchmarkStaticMeta("USD", {
      rate,
      recordDate: "2026-04-20",
      fetchedAt: observedAt,
      ageSeconds: 0,
      source: "fred-dgs3mo-test",
      isFallback: false,
      fallbackMode: null,
    }),
    lastMarketRate: rate,
    lastMarketRecordDate: "2026-04-20",
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
