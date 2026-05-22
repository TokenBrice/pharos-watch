export function buildSnapshotRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    profile: "treasury",
    rank: 1,
    score: 87.4,
    confidence: 92,
    components: [],
    whyKeys: ["top-safety"],
    whyText: "USDC ranked here because Safety and resilience are strong.",
    watchText: "Dependency risk is the lowest sub-dimension to monitor.",
    lowestSubDimension: {
      key: "dependencyRisk",
      score: 84,
      contextKeys: [],
    },
    chainHints: {
      topByLiquidity: ["ethereum"],
      topByYield: [],
      primary: "ethereum",
    },
    isRecentListing: false,
    bluechipGrade: "A",
    safetyGrade: "A",
    supplyUsd: 34000000000,
    isBeta: true,
    recommendedSource: null,
    perInputStaleness: null,
    ...overrides,
  };
}

export function buildSnapshotComponent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: "safetyOverall",
    weight: 30,
    rawValue: 88,
    normalizedValue: 88,
    contribution: 26.4,
    redistributed: false,
    ...overrides,
  };
}

export function buildYieldSnapshotRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildSnapshotRecommendation({
    profile: "yield",
    components: [buildSnapshotComponent({ key: "pharosYieldScore", weight: 28 })],
    whyKeys: ["top-pys"],
    recommendedSource: {
      protocol: "aave",
      chain: "ethereum",
      apy30d: 4.2,
      pharosYieldScore: 81,
      sourceRiskTier: "low",
      freshness: { capturedAt: 1715000123, ageSeconds: 42 },
    },
    perInputStaleness: null,
    ...overrides,
  });
}

export function buildTradingSnapshotRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildSnapshotRecommendation({
    profile: "trading",
    components: [buildSnapshotComponent({ key: "liquidity", weight: 30 })],
    whyKeys: ["deepest-liquidity"],
    recommendedSource: null,
    perInputStaleness: {
      pegSummary: 10,
      dexTvl: 20,
      dews: 30,
    },
    ...overrides,
  });
}

export function buildSelectorSnapshotOutput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    profile: "treasury",
    engineVersion: "selector-v1.2",
    datasetHash: "abc123",
    timestamp: 1715000000,
    input: {
      profile: "treasury",
      pegCurrency: "USD",
      horizon: "6mplus",
      depegTolerance: "zero",
      composability: "moderate",
      exitSpeed: "any",
      minApy: null,
      yieldNativeOnly: false,
      decentralization: "any",
      custodyOk: "any",
    },
    universe: { active: 392, surviving: 12 },
    recommended: [buildSnapshotRecommendation()],
    lowerRanked: [],
    coverageWarnings: {
      skippedForCoverageCount: 0,
      sparse: false,
      uneven: false,
      skippedForCoverage: [],
      newListingCount: 0,
      redistributionCount: 0,
    },
    lowConfidence: false,
    usedRelaxedFallback: false,
    relaxedReasons: [],
    exclusionSummary: [],
    closestSurvivors: [],
    relaxableConstraints: [],
    methodologyVersions: {
      safetyScore: "v7.25",
      pegScoreAndDews: "v5.9",
      yieldIntelligence: "v8.0",
      bluechipAlignment: "v1.0",
      exclusionFilters: "selector-v1.2",
    },
    ...overrides,
  };
}
