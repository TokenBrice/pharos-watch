import { buildDependencyGraphEdges } from "@shared/lib/dependency-graph";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
} from "@shared/lib/report-cards";
import type {
  StablecoinMeta,
  GovernanceType,
  GovernanceQuality,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
} from "@shared/types/core";
import type {
  ReportCard,
  ReportCardGrade,
} from "@shared/types/report-cards";
import type { CollateralDriftEntry } from "./collateral-drift";

export function buildDefunctReportCards(): ReportCard[] {
  return DEAD_STABLECOINS.map((dead) => {
    const id = dead.llamaId ?? `dead-${dead.symbol.toLowerCase()}`;
    const nrDim = { grade: "F" as const, score: 0, detail: "Defunct stablecoin" };
    return {
      id,
      name: dead.name,
      symbol: dead.symbol,
      overallGrade: "F" as const,
      overallScore: 0,
      baseScore: null,
      dimensions: {
        pegStability: nrDim,
        liquidity: nrDim,
        resilience: nrDim,
        decentralization: nrDim,
        dependencyRisk: nrDim,
      },
      ratedDimensions: 5,
      rawInputs: {
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
        chainTier: "ethereum" as ChainTier,
        deploymentModel: "single-chain" as DeploymentModel,
        collateralQuality: "native" as CollateralQuality,
        custodyModel: "onchain" as CustodyModel,
        governanceTier: "centralized" as GovernanceType,
        governanceQuality: "single-entity" as GovernanceQuality,
        dependencies: [],
        navToken: false,
        collateralFromLive: false,
      },
      isDefunct: true,
    };
  });
}

export function sortReportCards(cards: ReportCard[]): ReportCard[] {
  return [...cards].sort((a, b) => {
    if (a.overallScore === null && b.overallScore === null) return 0;
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });
}

export function buildReportCardsSnapshotEnvelope(input: {
  cards: ReportCard[];
  updatedAt: number;
  liquidityStale: boolean;
  collateralDriftCoins: CollateralDriftEntry[];
  liveToFallbackCoins: string[];
}) {
  return {
    cards: input.cards,
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      thresholds: GRADE_THRESHOLDS as { grade: ReportCardGrade; min: number }[],
    },
    dependencyGraph: { edges: buildDependencyGraphEdges(ACTIVE_STABLECOINS as StablecoinMeta[]) },
    updatedAt: input.updatedAt,
    liquidityStale: input.liquidityStale,
    ...(input.collateralDriftCoins.length > 0 ? { collateralDriftCoins: input.collateralDriftCoins } : {}),
    ...(input.liveToFallbackCoins.length > 0 ? { liveToFallbackCoins: input.liveToFallbackCoins } : {}),
  };
}
