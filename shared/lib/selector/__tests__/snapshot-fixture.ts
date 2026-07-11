export function buildSnapshotRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    profile: "treasury",
    rank: 1,
    score: 85.9,
    confidence: 92,
    components: buildTreasurySnapshotComponents(),
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

function component(
  key: string,
  weight: number,
  rawValue: number | null,
  normalizedValue: number | null,
): Record<string, unknown> {
  return buildSnapshotComponent({
    key,
    weight,
    rawValue,
    normalizedValue,
    contribution: normalizedValue === null ? 0 : (weight * normalizedValue) / 100,
    redistributed: rawValue === null,
  });
}

function buildTreasurySnapshotComponents(): Record<string, unknown>[] {
  return [
    component("safetyOverall", 30, 88, 88),
    component("resilience", 22, 84, 84),
    component("dependencyRisk", 20, 84, 84),
    component("pegStabilityHistory", 15, 90, 90),
    component("decentralization", 10, 80, 80),
    component("dewsInverted", 3, 10, 90),
  ];
}

function buildYieldSnapshotComponents(): Record<string, unknown>[] {
  return [
    component("pharosYieldScore", 28, 81, 81),
    component("yieldVariance", 16, 0.4, 90),
    component("safetyOverall", 14, 88, 88),
    component("sourceRiskInverted", 13, 15, 85),
    component("excessApy", 5, 4, 70.71067811865476),
    component("pegStabilityLive", 13, 92, 92),
    component("liquidity", 6, 85, 85),
    component("resilience", 5, 84, 84),
  ];
}

function buildTradingSnapshotComponents(): Record<string, unknown>[] {
  return [
    component("liquidity", 30, 85, 85),
    component("pegScoreNow", 23, 92, 92),
    component("dewsInverted", 15, 10, 90),
    component("pegStabilityLive", 12, 90, 90),
    component("effectiveExit", 10, 80, 80),
    component("supplyLog", 5, 34_000_000_000, 97.82784323784464),
    component("safetyOverall", 4, 88, 88),
    component("liquidityDiversification", 1, 0.2, 80),
  ];
}

export function buildYieldSnapshotRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildSnapshotRecommendation({
    profile: "yield",
    components: buildYieldSnapshotComponents(),
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
    components: buildTradingSnapshotComponents(),
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
    engineVersion: "selector-v1.91",
    datasetHash: "a".repeat(64),
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
      exclusionFilters: "selector-v1.91",
    },
    ...overrides,
  };
}
