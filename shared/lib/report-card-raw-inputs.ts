import type { RawDimensionInputs } from "../types/report-cards";

export function createReportCardRawInputs(
  overrides: Partial<RawDimensionInputs> = {},
): RawDimensionInputs {
  const inputs: RawDimensionInputs = {
    pegScore: null,
    activeDepeg: false,
    activeDepegBps: null,
    depegEventCount: 0,
    lastEventAt: null,
    liquidityScore: null,
    effectiveExitScore: null,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: null,
    bluechipGrade: null,
    canBeBlacklisted: false,
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
    governanceTier: "centralized",
    governanceQuality: "single-entity",
    dependencies: [],
    variantParentId: null,
    variantKind: null,
    navToken: false,
    collateralFromLive: false,
    dependencyFromLive: false,
    ...overrides,
  };
  inputs.dependencies = overrides.dependencies ?? [];
  return inputs;
}
