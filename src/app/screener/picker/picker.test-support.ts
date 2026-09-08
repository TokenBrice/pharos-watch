import type { SelectorInput, SelectorOutput } from "@shared/lib/selector";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

export const baseRecommendation = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  rank: 1 as const,
  score: 89.5,
  confidence: 88,
  components: [
    {
      key: "resilience" as const,
      weight: 50,
      rawValue: 91,
      normalizedValue: 91,
      contribution: 45.5,
      redistributed: false,
    },
    {
      key: "dependencyRisk" as const,
      weight: 50,
      rawValue: 88,
      normalizedValue: 88,
      contribution: 44,
      redistributed: false,
    },
  ],
  whyKeys: ["top-safety", "strong-resilience"] as SelectorOutput["recommended"][number]["whyKeys"],
  lowestSubDimension: {
    key: "decentralization" as const,
    score: 45,
    contextKeys: [],
  },
  chainHints: { topByLiquidity: ["Ethereum"], topByYield: [], primary: "Ethereum" },
  isRecentListing: false,
  bluechipGrade: "A" as const,
  safetyGrade: "A" as const,
  supplyUsd: 32_000_000_000,
  isBeta: true as const,
};

export function mockSelectorOutput(
  overrides: {
    profile?: "treasury" | "yield" | "trading";
    pegCurrency?: "USD" | "EUR" | "CHF" | "GOLD";
    input?: SelectorInput;
    recommended?: SelectorOutput["recommended"];
    lowerRanked?: SelectorOutput["lowerRanked"];
    closestSurvivors?: SelectorOutput["closestSurvivors"];
  } = {},
): SelectorOutput {
  const profile = overrides.profile ?? "treasury";
  const pegCurrency = overrides.pegCurrency ?? "USD";
  const input = overrides.input ?? {
    profile,
    pegCurrency,
    horizon: "6mplus" as const,
    depegTolerance: "zero" as const,
    composability: "none" as const,
    exitSpeed: "any" as const,
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any" as const,
    custodyOk: "any" as const,
  };
  return {
    profile,
    input,
    universe: { active: 12, surviving: 12 },
    recommended: overrides.recommended ?? [profile === "yield"
      ? {
          ...structuredClone(baseRecommendation), profile, perInputStaleness: null,
          recommendedSource: {
            protocol: "Aave", chain: "Ethereum", apy30d: 4, pharosYieldScore: 80,
            sourceRiskTier: "low", freshness: { capturedAt: 1_700_000_000, ageSeconds: 0 },
          },
        }
      : profile === "trading"
        ? { ...structuredClone(baseRecommendation), profile, recommendedSource: null, perInputStaleness: {} }
        : { ...structuredClone(baseRecommendation), profile, recommendedSource: null, perInputStaleness: null }],
    lowerRanked: overrides.lowerRanked ?? [],
    coverageWarnings: {
      skippedForCoverageCount: 0,
      skippedForCoverage: [],
      sparse: false,
      uneven: false,
      newListingCount: 0,
      redistributionCount: 0,
    },
    lowConfidence: false,
    usedRelaxedFallback: false,
    relaxedReasons: [],
    exclusionSummary: [],
    closestSurvivors: overrides.closestSurvivors ?? [],
    relaxableConstraints: [],
    timestamp: 1_700_000_000_000,
    engineVersion: "selector-v1.2",
    methodologyVersions: {
      safetyScore: "v7.25",
      pegScoreAndDews: "v3",
      yieldIntelligence: "v8",
      bluechipAlignment: "v1",
      exclusionFilters: "selector-v1.2",
    },
    datasetHash: "a".repeat(64),
  };
}

export function makePickerQueryData() {
  const query = <T,>(data: T) => ({ data, dataUpdatedAt: 1, error: null });
  return {
    usePegSummary: () => query({ coins: [] }),
    useReportCardsV9: () => query(makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", grade: "A", score: 90 })] })),
    useStressSignals: () => query({ signals: {} }),
    useDexLiquidity: () => query({}),
    useYieldRankings: () => query({ rankings: [] }),
    useBluechipRatings: () => query({}),
    useRedemptionBackstops: () => query({ coins: {} }),
  };
}
