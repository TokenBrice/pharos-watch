import type { DimensionKey, ReportCard, ReportCardDimension } from "@shared/types";

type TestReportCardDimension = Omit<ReportCardDimension, "detail"> & { detail?: string };
type TestReportCardDimensions = Record<DimensionKey, TestReportCardDimension>;
type TestReportCardOverrides = Omit<Partial<ReportCard>, "dimensions"> & {
  dimensions?: TestReportCardDimensions;
};

const DEFAULT_DIMENSIONS = {
  pegStability: { score: 95, grade: "A" },
  liquidity: { score: 90, grade: "A" },
  resilience: { score: 88, grade: "B+" },
  decentralization: { score: 70, grade: "B-" },
  dependencyRisk: { score: 62, grade: "C" },
} satisfies TestReportCardDimensions;

const CORE_SETTLEMENT_DIMENSIONS = {
  ...DEFAULT_DIMENSIONS,
  dependencyRisk: { score: 95, grade: "A+" },
} satisfies TestReportCardDimensions;

function withDimensionDetails(dimensions: TestReportCardDimensions): ReportCard["dimensions"] {
  return Object.fromEntries(
    Object.entries(dimensions).map(([key, dimension]) => [
      key,
      { ...dimension, detail: dimension.detail ?? "" },
    ]),
  ) as ReportCard["dimensions"];
}

export function makeReportCard(overrides: TestReportCardOverrides = {}): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallScore: overrides.overallScore !== undefined ? overrides.overallScore : 92,
    overallGrade: overrides.overallGrade ?? "A",
    isDefunct: overrides.isDefunct ?? false,
    dimensions: withDimensionDetails(overrides.dimensions ?? DEFAULT_DIMENSIONS),
    rawInputs: overrides.rawInputs ?? {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: 65,
      redemptionRouteFamily: "offchain-issuer",
      redemptionModelConfidence: "medium",
      redemptionUsedForLiquidity: true,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: 0.01,
      bluechipGrade: null,
      canBeBlacklisted: true,
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
      collateralQuality: "rwa",
      custodyModel: "institutional-top",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: true,
    },
  } as ReportCard;
}

export function makeCoreSettlementReportCard(overrides: TestReportCardOverrides = {}): ReportCard {
  return makeReportCard({
    ...overrides,
    dimensions: overrides.dimensions ?? CORE_SETTLEMENT_DIMENSIONS,
  });
}
