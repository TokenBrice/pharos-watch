import { describe, expect, it } from "vitest";

import {
  getYieldBenchmarkDisplayLabel,
  getYieldBenchmarkGapReferenceText,
  getYieldBenchmarkGapUnavailableText,
  getYieldRankingBenchmarkKey,
  resolveYieldScatterBenchmarkFrame,
} from "@/lib/yield-benchmark";
import type { YieldBenchmarkKey, YieldBenchmarkRegistry, YieldRanking, YieldRankingProvenance } from "@shared/types";

const BENCHMARKS: YieldBenchmarkRegistry = {
  USD: {
    key: "USD",
    label: "USD 3M T-Bill",
    currency: "USD",
    rate: 4.25,
    recordDate: "2026-03-26",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "fred-dgs3mo",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
  EUR: {
    key: "EUR",
    label: "EUR 3M compounded €STR",
    currency: "EUR",
    rate: 1.94,
    recordDate: "2026-03-26",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "ecb-estr-3m",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
  CHF: {
    key: "CHF",
    label: "CHF 3M compounded SARON",
    currency: "CHF",
    rate: -0.05,
    recordDate: "2026-03-25",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "six-sar3mc",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
};

function buildProvenance(benchmarkKey: YieldBenchmarkKey): YieldRankingProvenance {
  return {
    sourceKey: "test-source",
    sourceObservedAt: 1774483200,
    sourceAgeSeconds: 0,
    comparisonAnchorObservedAt: null,
    comparisonAnchorAgeSeconds: null,
    confidenceTier: "curated",
    selectionMethod: "confidence-weighted",
    selectionReason: "test",
    sourceSwitch: false,
    previousBestSourceKey: null,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    benchmarkKey,
    benchmarkLabel: BENCHMARKS[benchmarkKey]?.label,
    benchmarkCurrency: benchmarkKey,
    benchmarkRate: BENCHMARKS[benchmarkKey]?.rate,
    benchmarkRecordDate: BENCHMARKS[benchmarkKey]?.recordDate ?? null,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    anomalies: [],
  };
}

function buildRanking(id: string, benchmarkKey: "USD" | "EUR" | "CHF"): YieldRanking {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    currentApy: 4,
    apy7d: 4,
    apy30d: 4,
    apyBase: 4,
    apyReward: null,
    yieldSource: "Test Source",
    yieldSourceUrl: null,
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 1_000_000,
    pharosYieldScore: 10,
    safetyScore: 70,
    safetyGrade: "B",
    yieldToRisk: 0.1,
    excessYield: 0.1,
    benchmarkKey,
    benchmarkLabel: BENCHMARKS[benchmarkKey]?.label,
    benchmarkCurrency: benchmarkKey,
    benchmarkRate: BENCHMARKS[benchmarkKey]?.rate,
    benchmarkRecordDate: BENCHMARKS[benchmarkKey]?.recordDate ?? null,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.8,
    apyVariance30d: 0.2,
    apyMin30d: 3.8,
    apyMax30d: 4.2,
    warningSignals: [],
    altSources: [],
    provenance: buildProvenance(benchmarkKey),
  };
}

describe("getYieldBenchmarkDisplayLabel", () => {
  it("adds the fallback suffix when a row is using a fallback benchmark", () => {
    expect(
      getYieldBenchmarkDisplayLabel({
        benchmarkLabel: "USD 3M T-Bill",
        benchmarkIsFallback: true,
      }),
    ).toBe("USD 3M T-Bill (fallback)");
  });
});

describe("yield benchmark gap copy", () => {
  it("builds a shared 30d benchmark subtitle for excess yield callouts", () => {
    expect(
      getYieldBenchmarkGapReferenceText({
        benchmarkLabel: "USD 3M T-Bill",
      }),
    ).toBe("30d vs USD 3M T-Bill");
    expect(
      getYieldBenchmarkGapReferenceText({
        benchmarkLabel: "USD 3M T-Bill",
      }, { includePeriod: false }),
    ).toBe("vs USD 3M T-Bill");
  });

  it("builds the shared no-gap fallback copy", () => {
    expect(getYieldBenchmarkGapUnavailableText()).toBe("No 30d benchmark gap");
  });
});

describe("resolveYieldScatterBenchmarkFrame", () => {
  it("uses the provenance benchmark key when the top-level key is absent", () => {
    const { benchmarkKey: _benchmarkKey, ...rankingWithoutBenchmarkKey } = buildRanking("eur-fallback", "USD");
    const ranking: YieldRanking = {
      ...rankingWithoutBenchmarkKey,
      provenance: buildProvenance("EUR"),
    };

    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [ranking],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(getYieldRankingBenchmarkKey(ranking)).toBe("EUR");
    expect(result.hasMixedBenchmarks).toBe(false);
    expect(result.usesDefaultBenchmarkFrame).toBe(false);
    expect(result.sharedBenchmarkKey).toBe("EUR");
    expect(result.referenceBenchmark?.key).toBe("EUR");
  });

  it("uses the shared native benchmark when the visible set is homogeneous", () => {
    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [buildRanking("eur-a", "EUR"), buildRanking("eur-b", "EUR")],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(result.hasMixedBenchmarks).toBe(false);
    expect(result.usesDefaultBenchmarkFrame).toBe(false);
    expect(result.sharedBenchmarkKey).toBe("EUR");
    expect(result.referenceBenchmark?.key).toBe("EUR");
  });

  it("uses the USD default benchmark frame when the visible set mixes currencies", () => {
    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [buildRanking("usd-a", "USD"), buildRanking("eur-a", "EUR"), buildRanking("chf-a", "CHF")],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(result.hasMixedBenchmarks).toBe(true);
    expect(result.usesDefaultBenchmarkFrame).toBe(true);
    expect(result.sharedBenchmarkKey).toBeNull();
    expect(result.referenceBenchmark?.key).toBe("USD");
  });
});
