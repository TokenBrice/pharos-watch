import type { AltYieldSource, YieldRanking, YieldRankingProvenance } from "../../types";

export function makeYieldProvenance(
  overrides: Partial<YieldRankingProvenance> = {},
): YieldRankingProvenance {
  return {
    sourceKey: "selected-source",
    sourceObservedAt: 1_776_000_000,
    sourceAgeSeconds: 300,
    comparisonAnchorObservedAt: null,
    comparisonAnchorAgeSeconds: null,
    confidenceTier: "curated",
    selectionMethod: "confidence-weighted",
    selectionReason: "selected by confidence-weighted arbitration",
    sourceSwitch: false,
    previousBestSourceKey: null,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    anomalies: [],
    ...overrides,
  };
}

export function makeAltYieldSource(overrides: Partial<AltYieldSource> = {}): AltYieldSource {
  return {
    sourceKey: "alt-source",
    yieldSource: "Aave V3 USDC",
    yieldSourceUrl: "https://example.com/aave",
    yieldType: "lending-opportunity",
    currentApy: 4,
    apy30d: 4,
    sourceTvlUsd: 2_000_000,
    dataSource: "defillama-auto",
    ...overrides,
  };
}

export function makeYieldRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 5,
    apy7d: 5,
    apy30d: 5,
    apyBase: null,
    apyReward: null,
    yieldSource: "Compound V3 USDC",
    yieldSourceUrl: "https://example.com/compound",
    yieldType: "lending-opportunity",
    dataSource: "protocol-api",
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 50,
    safetyScore: 80,
    safetyGrade: "A",
    yieldToRisk: 1.2,
    excessYield: 0.75,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.9,
    apyVariance30d: 0.3,
    apyMin30d: 4.5,
    apyMax30d: 5.5,
    warningSignals: [],
    altSources: [],
    provenance: makeYieldProvenance(),
    ...overrides,
  };
}
